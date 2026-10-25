import argparse
import importlib.metadata
import json
import math
import sys
from pathlib import Path


def emit(**value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["probe", "analyze"])
    parser.add_argument("--request")
    args = parser.parse_args()
    import numpy as np
    import torch
    from scipy.signal import resample_poly
    from ddc_onset import FRAME_RATE, SAMPLE_RATE, compute_onset_salience
    from ddc_onset import SpectrogramExtractor, SpectrogramNormalizer, PlacementCNN

    torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    if args.mode == "probe":
        SpectrogramExtractor()
        SpectrogramNormalizer()
        PlacementCNN()
        emit(kind="result", python=sys.version.split()[0], engine="ddc", version=importlib.metadata.version("ddc_onset"), frameRate=FRAME_RATE, cuda=torch.cuda.is_available())
        return
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    rate, frames = request["sampleRate"], request["frames"]
    if not isinstance(rate, int) or not 8000 <= rate <= 192000 or not isinstance(frames, int) or not 0 < frames <= rate * 183:
        raise ValueError("Invalid audio dimensions")
    audio = np.fromfile(request["input"], dtype="<f4")
    if audio.size != frames or not np.isfinite(audio).all():
        raise ValueError("Invalid audio samples")
    device = request["device"]
    if device not in ("auto", "cpu", "cuda"):
        raise ValueError("Invalid device")
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable; select CPU or auto")
    if rate != SAMPLE_RATE:
        divisor = math.gcd(rate, SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // divisor, rate // divisor).astype(np.float32)
    hop = SAMPLE_RATE // FRAME_RATE
    count = math.ceil(audio.size / hop)
    salience = np.zeros(count, dtype=np.float32)
    chunk_frames, context_frames = 1200, FRAME_RATE
    emit(kind="progress", stage="model", message="正在加载 DDC 起音模型…")
    for first in range(0, count, chunk_frames):
        last = min(count, first + chunk_frames)
        begin, end = max(0, first - context_frames), min(count, last + context_frames)
        samples = audio[begin * hop:end * hop]
        samples = np.pad(samples, (0, max(0, SAMPLE_RATE // 2 - samples.size)))
        scores = compute_onset_salience(samples, SAMPLE_RATE, device=torch.device(device))
        selected = scores[first - begin:last - begin]
        if selected.size != last - first or not np.isfinite(selected).all():
            raise ValueError("Invalid model output")
        salience[first:last] = selected
        emit(kind="progress", stage="analyzing", completed=last, total=count, message=f"起音检测 {last / count:.0%}")
    padded = np.pad(audio, (0, count * hop - audio.size))
    energy = np.mean(padded.reshape(count, hop) ** 2, axis=1)
    audible = np.convolve(energy, np.ones(11), "same")[:count]
    salience[audible < max(1e-12, float(energy.max()) * 1e-8)] = 0
    salience.astype("<f4").tofile(request["output"])
    emit(kind="result", engine="ddc", version=importlib.metadata.version("ddc_onset"), frameRate=FRAME_RATE, frames=count, device=device)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(kind="error", message=str(error))
        sys.exit(1)
