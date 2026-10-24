import argparse
import json
import math
import sys
import time
import urllib.request
import zipfile
from datetime import timedelta
from pathlib import Path


SOURCE_REVISION = "0e2b0e387aab4b35c64b0b11b12d47578dea7587"
SLIDER_REVISION = "ea28c484a0a542d6e094e25aa02e1529ff2c8313"
MODELS = {
    "v32": ("OliBomby/Mapperatorinator-v32", "74f22583400d259bf424819e11027c17933efe54"),
    "v32-mini": ("OliBomby/Mapperatorinator-v32-mini", "7807f0dc70cab671be012e1f5ddf945b0b8b7278"),
}


def emit(**value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def extract_source(destination, repo, revision, skip_examples=False):
    directory = Path(destination).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / "source.zip"
    url = f"https://github.com/{repo}/archive/{revision}.zip"
    emit(kind="progress", stage="environment", message=f"下载 {repo} 推理源码…")
    with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 32 * 1024 * 1024:
                raise ValueError("Source archive is too large")
            output.write(chunk)
    with zipfile.ZipFile(archive) as package:
        if len(package.infolist()) > 10000 or sum(item.file_size for item in package.infolist()) > 256 * 1024 * 1024:
            raise ValueError("Source archive is too large")
        for item in package.infolist():
            if skip_examples and "/example_data/beatmaps/" in item.filename:
                continue
            target = (directory / item.filename).resolve()
            target.relative_to(directory)
            if item.filename.startswith(("/", "\\")) or "\\" in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Invalid source path")
            package.extract(item, directory)
    archive.unlink()
    return directory / (repo.split("/")[-1] + "-" + revision)


def prepare_source(destination):
    source = extract_source(destination, "OliBomby/Mapperatorinator", SOURCE_REVISION)
    slider = extract_source(destination, "OliBomby/slider", SLIDER_REVISION, skip_examples=True)
    emit(kind="result", source=str(source), slider=str(slider), revision=SOURCE_REVISION)


def load_library(source, model_name):
    source = Path(source).resolve()
    if not (source / "osuT5/osuT5/inference/processor.py").is_file():
        raise ValueError("Mapperatorinator source directory is missing")
    sys.path.insert(0, str(source))
    from config import InferenceConfig
    from hydra import compose, initialize_config_dir
    from omegaconf import OmegaConf
    with initialize_config_dir(config_dir=str(source / "configs/inference"), version_base="1.1"):
        args = OmegaConf.to_object(compose(config_name=model_name))
    return args


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "probe", "generate"])
    parser.add_argument("--source")
    parser.add_argument("--request")
    args = parser.parse_args()
    if args.mode == "prepare":
        prepare_source(args.source)
        return
    import numpy as np
    import torch
    from scipy.signal import resample_poly
    from huggingface_hub import snapshot_download
    from huggingface_hub.constants import HF_HOME
    request = json.loads(Path(args.request).read_text(encoding="utf-8")) if args.mode == "generate" else None
    inference = load_library(args.source, request["model"] if request else "v32")
    from osuT5.osuT5.model import Mapperatorinator
    from osuT5.osuT5.tokenizer import Tokenizer
    from osuT5.osuT5.event import ContextType, EventType
    from osuT5.osuT5.inference import Preprocessor, Processor, GenerationConfig, Postprocessor
    from osuT5.osuT5.dataset.data_utils import get_groups, normalize_audio_samples
    from slider import TimingPoint
    if args.mode == "probe":
        emit(kind="result", engine="mapper", python=sys.version.split()[0], torch=torch.__version__, cuda=torch.cuda.is_available(), mps=torch.backends.mps.is_available(), revision=SOURCE_REVISION)
        return
    rate, frames = request["sampleRate"], request["frames"]
    if not isinstance(rate, int) or not 8000 <= rate <= 192000 or not isinstance(frames, int) or not 0 < frames <= rate * 213:
        raise ValueError("Invalid audio dimensions")
    samples = np.fromfile(request["input"], dtype="<f4")
    if len(samples) != frames or not np.isfinite(samples).all():
        raise ValueError("Invalid audio samples")
    model_name, gamemode = request["model"], request["gamemode"]
    if model_name not in MODELS or gamemode not in (0, 3):
        raise ValueError("Invalid generation model or mode")
    device = request["device"]
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    if device not in ("cpu", "cuda", "mps") or device == "cuda" and not torch.cuda.is_available() or device == "mps" and not torch.backends.mps.is_available():
        raise ValueError("Selected computing device is unavailable")
    repo, revision = MODELS[model_name]

    def save_result(objects, elapsed, windows):
        result = {"engine": "mapper", "model": model_name, "modelRevision": revision, "sourceRevision": SOURCE_REVISION, "gamemode": gamemode, "difficulty": request["difficulty"], "seed": request["seed"], "device": device, "usedChartTiming": bool(request["timing"]), "objects": objects, "elapsedSeconds": elapsed, "windows": windows}
        Path(request["output"]).write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")
        emit(kind="result", engine="mapper", objects=len(objects), model=model_name, device=device)

    if float(np.max(np.abs(samples))) < 1e-7:
        save_result([], 0, 0)
        return
    torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    torch.set_grad_enabled(False)
    from accelerate.utils import set_seed
    set_seed(request["seed"])
    emit(kind="progress", stage="model", message=f"加载 Mapperatorinator {model_name}，首次使用将下载模型…")
    dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32

    def load_checkpoint(folder):
        files = ["config.json", "model.safetensors", "generation_config.json", "tokenizer.json"]
        allowed = ([f"{folder}/{name}" for name in files] if folder else files) + ["README.md"]
        checkpoint = Path(snapshot_download(repo_id=repo, revision=revision, allow_patterns=allowed, local_dir=Path(HF_HOME) / "rpen" / model_name / revision))
        if folder:
            checkpoint = checkpoint / folder
        network = Mapperatorinator.from_pretrained(str(checkpoint), dtype=dtype, attn_implementation="sdpa", local_files_only=True).eval().to(device)
        network.generation_config.disable_compile = True
        vocabulary = Tokenizer.from_pretrained(str(checkpoint), local_files_only=True)
        return network, vocabulary

    model, tokenizer = load_checkpoint(f"gamemode={gamemode}")
    inference.device, inference.precision = device, "bf16" if dtype == torch.bfloat16 else "fp32"
    inference.fast_decoder_loop = False
    inference.use_server = False
    inference.parallel = False
    inference.max_batch_size = 2
    inference.generate_positions = False
    inference.do_sample = True
    inference.temperature, inference.top_p = .9, .9
    inference.gamemode = gamemode
    inference.start_time = round((request["startSeconds"] - request["originSeconds"]) * 1000)
    inference.end_time = round((request["endSeconds"] - request["originSeconds"]) * 1000)
    target_rate = inference.train.data.sample_rate
    divisor = math.gcd(rate, target_rate)
    if rate != target_rate:
        samples = resample_poly(samples, target_rate // divisor, rate // divisor).astype(np.float32)
    if inference.train.data.normalize_audio:
        samples = normalize_audio_samples(samples)
    timing = [TimingPoint(timedelta(seconds=point["seconds"]), 60000 / point["bpm"], 4, 2, -1, 100, None, False) for point in request["timing"]]
    sequences, sequence_times, _ = Preprocessor(inference).segment(samples)
    sequence_times = sequence_times.to(torch.int64) + round(request["originSeconds"] * 1000)
    inference.start_time = round(request["startSeconds"] * 1000)
    inference.end_time = round(request["endSeconds"] * 1000)
    generation = GenerationConfig(gamemode=gamemode, difficulty=request["difficulty"], year=2024, hitsounded=False, keycount=4, hold_note_ratio=0., scroll_speed_ratio=0.)
    sequence_data = (sequences, sequence_times, request["sourceDuration"] * 1000)
    if not timing:
        emit(kind="progress", stage="timing", message="加载基础模型，推断 BPM 与节拍相位…")
        timing_model, timing_tokenizer = load_checkpoint("")
        timing_processor = Processor(inference, timing_model, timing_tokenizer)
        timing_events, _ = timing_processor.generate(sequences=sequence_data, generation_config=generation, in_context=[], out_context=[ContextType.TIMING], verbose=False)[0]
        timing = Postprocessor(inference).generate_timing(timing_events)
        if not timing:
            raise ValueError("模型未生成可用的 BPM 上下文，请提供谱面 BPM 或扩大分析区间")
        del timing_processor, timing_model
        if device == "cuda":
            torch.cuda.empty_cache()
    processor = Processor(inference, model, tokenizer)
    previous_generate = processor.model_generate
    windows_done = 0

    def generate_window(*values, **named):
        nonlocal windows_done
        windows_done += 1
        emit(kind="progress", stage="generating", message=f"正在生成节奏，第 {windows_done} 个窗口…")
        return previous_generate(*values, **named)

    processor.model_generate = generate_window
    started = time.perf_counter()
    output = processor.generate(sequences=sequence_data, generation_config=generation, in_context=[], out_context=[ContextType.MAP], extra_in_context={ContextType.TIMING: timing}, verbose=False)
    events = output[0][0]
    heads = {EventType.CIRCLE, EventType.SLIDER_HEAD, EventType.HOLD_NOTE, EventType.SPINNER, EventType.DRUMROLL, EventType.DENDEN}
    if not any(event.type in heads for event in events):
        save_result([], time.perf_counter() - started, windows_done)
        return
    if timing and events:
        events = Postprocessor(inference).resnap_events(events, timing)
    groups, _ = get_groups(events, types_first=inference.train.data.types_first) if events else ([], [])
    objects = []
    for group in groups:
        seconds = group.time / 1000
        if group.event_type not in heads or not request["startSeconds"] <= seconds < request["endSeconds"]:
            continue
        sample = round((seconds - request["originSeconds"]) * target_rate)
        vicinity = samples[max(0, sample - target_rate // 40):min(len(samples), sample + target_rate // 40 + 1)]
        if vicinity.size and float(np.max(np.abs(vicinity))) >= 1e-7:
            objects.append({"seconds": seconds, "type": group.event_type.value})
    save_result(objects, time.perf_counter() - started, windows_done)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(kind="error", message=str(error))
        raise
