"""Build the benchmark sets under data/sets/ (all 48 kHz mono WAV).

vbd       100 VoiceBank-DEMAND test clips: noisy input + clean reference
degraded   60 VCTK clean clips x 6 "old/low-quality" degradations + clean reference
real       DNS Challenge real recordings (no reference)
speed      one 10-minute noisy speech file for RTF / RAM
external   12-clip pack (4 per set) for Adobe Podcast / Krisp

Run with the env-onnx interpreter:  envs/onnx/Scripts/python prepare_data.py
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr
from scipy.signal import fftconvolve

ROOT = Path(__file__).parent
DATA = ROOT / "data"
SETS = DATA / "sets"
SR = 48_000
RNG = np.random.default_rng(1234)


def read(path: Path) -> np.ndarray:
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    return soxr.resample(x, sr, SR) if sr != SR else x


def write(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    peak = np.abs(x).max()
    if peak > 0.99:
        x = x * (0.99 / peak)
    sf.write(path, x.astype(np.float32), SR, subtype="FLOAT")


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x**2) + 1e-12))


def add_at_snr(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    noise = np.resize(noise, speech.shape)
    gain = rms(speech) / (rms(noise) * 10 ** (snr_db / 20))
    return speech + gain * noise


def ffmpeg_filter(x: np.ndarray, args: list[str], tmp: Path) -> np.ndarray:
    src, dst = tmp / "in.wav", tmp / "out.wav"
    sf.write(src, x, SR)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), *args, "-ar", str(SR), "-ac", "1", str(dst)], check=True)
    return read(dst)


def synthetic_rir(rt60: float) -> np.ndarray:
    n = int(rt60 * SR)
    t = np.arange(n) / SR
    decay = np.exp(-6.9 * t / rt60)  # -60 dB at rt60
    rir = RNG.standard_normal(n) * decay
    rir[: int(0.002 * SR)] *= 0.2
    rir[0] = 1.0  # direct path
    return (rir / np.abs(rir).max()).astype(np.float32)


def reverb(x: np.ndarray, rt60: float) -> np.ndarray:
    y = fftconvolve(x, synthetic_rir(rt60))[: len(x)]
    return y * (rms(x) / rms(y))


def degrade(kind: str, x: np.ndarray, noise: np.ndarray, tmp: Path) -> np.ndarray:
    if kind == "phone":
        return ffmpeg_filter(x, ["-af", "highpass=f=300,lowpass=f=3400,aresample=8000"], tmp)
    if kind == "mp3_32k":
        mp3 = tmp / "low.mp3"
        sf.write(tmp / "in.wav", x, SR)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp / "in.wav"), "-ac", "1", "-ar", "22050",
                        "-c:a", "libmp3lame", "-b:a", "32k", str(mp3)], check=True)
        return read(mp3)[: len(x)]
    if kind == "reverb":
        return reverb(x, 0.7)
    if kind == "clipping":
        y = x * (0.9 / (np.abs(x).max() + 1e-9)) * 4.0
        return np.clip(y, -0.9, 0.9)
    if kind == "hum_hiss":
        t = np.arange(len(x)) / SR
        hum = sum(np.sin(2 * np.pi * 50 * k * t) / k for k in (1, 2, 3, 5))
        y = add_at_snr(x, hum.astype(np.float32), 12)
        return add_at_snr(y, RNG.standard_normal(len(x)).astype(np.float32), 20)
    if kind == "combo":  # phone call from a reverberant noisy room
        y = add_at_snr(reverb(x, 0.5), noise, 5)
        return ffmpeg_filter(y, ["-af", "highpass=f=300,lowpass=f=3400,aresample=8000"], tmp)
    raise ValueError(kind)


def main() -> None:
    if SETS.exists():
        shutil.rmtree(SETS)
    tmp = DATA / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    clean_dir, noisy_dir = DATA / "clean_testset_wav", DATA / "noisy_testset_wav"
    names = sorted(p.name for p in clean_dir.glob("*.wav"))

    # 1. VoiceBank-DEMAND
    vbd = names[0::8][:100]
    for n in vbd:
        write(SETS / "vbd/noisy" / n, read(noisy_dir / n))
        write(SETS / "vbd/clean" / n, read(clean_dir / n))

    # 2. Degraded "old / low-quality" recordings; real DEMAND noise = noisy - clean of other clips
    kinds = ["phone", "mp3_32k", "reverb", "clipping", "hum_hiss", "combo"]
    pool = names[4::8][:60]
    noise_src = names[2::8][:60]
    for i, n in enumerate(pool):
        kind = kinds[i % len(kinds)]
        clean = read(clean_dir / n)
        m = noise_src[i]
        noise = read(noisy_dir / m) - read(clean_dir / m)
        out = f"{kind}__{n}"
        write(SETS / "degraded/noisy" / out, degrade(kind, clean, noise, tmp))
        write(SETS / "degraded/clean" / out, clean)

    # 3. Real recordings (no reference)
    for p in sorted((DATA / "real_raw").glob("*.wav")):
        write(SETS / "real/noisy" / p.name, read(p))

    # 4. Speed: 10 minutes of noisy speech
    parts, total = [], 0
    while total < 600 * SR:
        for n in names:
            x = read(noisy_dir / n)
            parts.append(x)
            total += len(x)
            if total >= 600 * SR:
                break
    write(SETS / "speed/noisy/speech_10min.wav", np.concatenate(parts)[: 600 * SR])

    # 5. External pack for manual tools (Adobe / Krisp)
    ext = ROOT / "external" / "input"
    if ext.exists():
        shutil.rmtree(ext)
    for set_name, files in [
        ("vbd", sorted((SETS / "vbd/noisy").glob("*.wav"))[:4]),
        ("degraded", [sorted((SETS / "degraded/noisy").glob(f"{k}__*.wav"))[0] for k in ("phone", "reverb", "hum_hiss", "combo")]),
        ("real", sorted((SETS / "real/noisy").glob("*.wav"))[:4]),
    ]:
        for f in files:
            ext.mkdir(parents=True, exist_ok=True)
            shutil.copy(f, ext / f"{set_name}__{f.name}")
    shutil.rmtree(tmp)
    for s in ("vbd", "degraded", "real", "speed"):
        print(s, len(list((SETS / s / "noisy").glob("*.wav"))), "clips")


if __name__ == "__main__":
    main()
