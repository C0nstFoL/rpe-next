import argparse
import importlib.metadata
import json
import sys
import wave
from pathlib import Path


def emit(**value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["probe", "separate"])
    parser.add_argument("--request")
    args = parser.parse_args()
    import torch
    if args.mode == "probe":
        from demucs.api import Separator
        emit(kind="result", python=sys.version.split()[0], demucs=importlib.metadata.version("demucs"), cuda=torch.cuda.is_available())
        return
    import numpy as np
    import sphn
    from demucs.api import Separator
    from julius import resample_frac

    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    if request["model"] not in ("htdemucs", "htdemucs_6s") or request["device"] not in ("auto", "cpu", "cuda"):
        raise ValueError("Unsupported model or device")
    torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    device = request["device"]
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable; select CPU or auto")
    emit(kind="progress", stage="model", message="正在加载模型，首次使用可能下载模型文件")

    def progress(info):
        emit(kind="progress", stage="separating", segment=int(info.get("segment_offset", 0)), frames=int(info.get("audio_length", 0)), state=str(info.get("state", "")))

    separator = Separator(model=request["model"], device=device, shifts=request["shifts"], segment=7, overlap=0.25, progress=False, callback=progress)
    data, sample_rate = sphn.read(request["input"])
    frames = data.shape[-1]
    _, stems = separator.separate_audio_file(Path(request["input"]))
    result = []
    for name, samples in stems.items():
        if name not in ("vocals", "drums", "bass", "other", "guitar", "piano"):
            raise ValueError("Unexpected stem name")
        samples = resample_frac(samples.detach().cpu(), separator.samplerate, int(sample_rate))
        if samples.shape[-1] < frames:
            samples = torch.nn.functional.pad(samples, (0, frames - samples.shape[-1]))
        samples = samples[:, :frames]
        if not torch.isfinite(samples).all():
            raise ValueError("Separation returned non-finite samples")
        filename = Path(request["output"]) / (name + ".wav")
        maximum = max(1.0, float(samples.abs().max()))
        encoded = np.rint(samples.numpy().T / maximum * 32767).astype("<i2")
        with wave.open(str(filename), "wb") as output:
            output.setnchannels(samples.shape[0])
            output.setsampwidth(2)
            output.setframerate(int(sample_rate))
            output.writeframes(encoded.tobytes())
        result.append({"id": name, "bytes": filename.stat().st_size, "sampleRate": int(sample_rate), "frames": frames})
        emit(kind="progress", stage="writing", message=name)
    emit(kind="result", sources=result, model=request["model"], device=device, sampleRate=int(sample_rate), frames=frames, engineVersion=importlib.metadata.version("demucs"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(kind="error", message=str(error))
        sys.exit(1)
