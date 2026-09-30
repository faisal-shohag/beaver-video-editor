"""Adapters for the shippable set, run in env-onnx.

Models: ffmpeg_rnnoise, ffmpeg_afftdn, dfn3, gtcrn, dpdfnet2_48k, dpdfnet8_48k, sidon
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import get_window

sys.path.insert(0, str(Path(__file__).parent))
from common import MODELS, fit_length, ort_session, read_mono, resample, run  # noqa: E402


# ---------------------------------------------------------------- FFmpeg built-ins
FFMPEG_CHAINS = {
    # RNNoise (Xiph) via FFmpeg's arnndn with the "standard" model.
    "ffmpeg_rnnoise": "highpass=f=70,arnndn=m=std.rnnn",
    # Classic DSP only: FFT denoiser with noise tracking.
    "ffmpeg_afftdn": "highpass=f=70,afftdn=nr=18:nf=-40:tn=1",
}


def ffmpeg_load(args):
    return FFMPEG_CHAINS[args.model]


def ffmpeg_enhance(chain, x, sr, timer):
    with tempfile.TemporaryDirectory() as d:
        src, dst = Path(d) / "in.wav", Path(d) / "out.wav"
        sf.write(src, x, sr)
        with timer:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", chain, "-ar", str(sr), str(dst)],
                           check=True, cwd=MODELS / "rnnoise")
        y, _ = read_mono(dst)
    return fit_length(y, len(x)), sr


# ---------------------------------------------------------------- DeepFilterNet3 (official Rust CLI)
def dfn3_load(args):
    return MODELS / "dfn3" / "deep-filter.exe"


def dfn3_enhance(exe, x, sr, timer):
    x48 = resample(x, sr, 48000)
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "in.wav"
        sf.write(src, x48, 48000, subtype="PCM_16")
        with timer:
            subprocess.run([str(exe), "-D", "-o", str(Path(d) / "o"), str(src)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        y, _ = read_mono(Path(d) / "o" / "in.wav")
    return fit_length(y, len(x48)), 48000


# ---------------------------------------------------------------- GTCRN (streaming ONNX, 16 kHz)
N_FFT, HOP = 512, 256
WIN = get_window("hann", N_FFT, fftbins=True).astype(np.float32) ** 0.5


def stft(x):
    pad = N_FFT // 2
    xp = np.pad(x, (pad, pad), mode="reflect")
    frames = 1 + (len(xp) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    return np.fft.rfft(xp[idx] * WIN, axis=1).T  # [F, T]


def istft(spec, length):
    frames = spec.shape[1]
    y = np.zeros(N_FFT + HOP * (frames - 1), dtype=np.float32)
    wsum = np.zeros_like(y)
    blocks = np.fft.irfft(spec.T, n=N_FFT, axis=1).astype(np.float32) * WIN
    for t in range(frames):
        y[t * HOP : t * HOP + N_FFT] += blocks[t]
        wsum[t * HOP : t * HOP + N_FFT] += WIN**2
    y /= np.maximum(wsum, 1e-8)
    pad = N_FFT // 2
    return fit_length(y[pad:], length)


def gtcrn_load(args):
    return ort_session(MODELS / "gtcrn" / "gtcrn_simple.onnx", args.provider, args.threads)


def gtcrn_enhance(sess, x, sr, timer):
    x16 = resample(x, sr, 16000)
    spec = stft(x16)  # [257, T]
    inp = np.stack([spec.real, spec.imag], axis=-1)[None].astype(np.float32)  # [1, 257, T, 2]
    conv = np.zeros([2, 1, 16, 16, 33], np.float32)
    tra = np.zeros([2, 3, 1, 1, 16], np.float32)
    inter = np.zeros([2, 1, 33, 16], np.float32)
    outs = []
    with timer:
        for t in range(inp.shape[2]):
            o, conv, tra, inter = sess.run(None, {"mix": inp[:, :, t : t + 1], "conv_cache": conv,
                                                  "tra_cache": tra, "inter_cache": inter})
            outs.append(o)
    o = np.concatenate(outs, axis=2)[0]  # [257, T, 2]
    return istft(o[..., 0] + 1j * o[..., 1], len(x16)), 16000


# ---------------------------------------------------------------- DPDFNet (Ceva, streaming ONNX)
def dpdfnet_load(args):
    os.environ["DPDFNET_MODEL_DIR"] = str(MODELS / "dpdfnet")
    import dpdfnet
    from dpdfnet import onnx_backend

    name = {"dpdfnet2_48k": "dpdfnet2_48khz_hr", "dpdfnet8_48k": "dpdfnet8_48khz_hr"}[args.model]
    timer_box = {}
    original = onnx_backend.build_runtime_model

    def timed_build(path, *a, **k):
        rt = original(path, *a, **k)
        inner = rt.session

        class TimedSession:
            def __getattr__(self, attr):
                return getattr(inner, attr)

            def run(self, *ra, **rk):
                t = timer_box.get("timer")
                if t is None:
                    return inner.run(*ra, **rk)
                with t:
                    return inner.run(*ra, **rk)

        import dataclasses

        return dataclasses.replace(rt, session=TimedSession())

    onnx_backend.build_runtime_model = timed_build
    dpdfnet.enhance(np.zeros(4800, np.float32), 48000, model=name)  # warm load / verify file
    return dpdfnet, name, timer_box


def dpdfnet_enhance(state, x, sr, timer):
    dpdfnet, name, box = state
    x48 = resample(x, sr, 48000)
    box["timer"] = timer
    y = dpdfnet.enhance(x48, 48000, model=name)
    box["timer"] = None
    return y, 48000


# ---------------------------------------------------------------- Sidon (restoration, int8 ONNX)
def sidon_load(args):
    from transformers import SeamlessM4TFeatureExtractor

    fe = SeamlessM4TFeatureExtractor.from_pretrained("facebook/w2v-bert-2.0")
    d = MODELS / "sidon"
    return fe, ort_session(d / "sidon-predictor.onnx", args.provider, args.threads), \
        ort_session(d / "sidon-vocoder.onnx", args.provider, args.threads)


SIDON_CHUNK = 16000 * 20  # 20 s windows keep attention cost and RAM bounded
SIDON_XFADE = 16000 // 2


def sidon_enhance(state, x, sr, timer):
    fe, pred, voc = state
    x16 = resample(x, sr, 16000)
    out_len = len(x16) * 3
    pieces = []
    step = SIDON_CHUNK - SIDON_XFADE
    for start in range(0, max(1, len(x16)), step):
        seg = x16[start : start + SIDON_CHUNK]
        if len(seg) < 1600:
            break
        feats = fe(seg, sampling_rate=16000, return_tensors="np")["input_features"].astype(np.float32)
        with timer:
            h = pred.run(None, {pred.get_inputs()[0].name: feats})[0]
            audio = voc.run(None, {voc.get_inputs()[0].name: h.astype(np.float32)})[0]
        pieces.append((start * 3, fit_length(audio.reshape(-1).astype(np.float32), len(seg) * 3)))
        if start + SIDON_CHUNK >= len(x16):
            break
    y = np.zeros(out_len, np.float32)
    w = np.zeros(out_len, np.float32)
    fade = SIDON_XFADE * 3
    for off, p in pieces:
        win = np.ones(len(p), np.float32)
        if off > 0:
            win[:fade] = np.linspace(0, 1, fade)
        if off + len(p) < out_len:
            win[-fade:] = np.minimum(win[-fade:], np.linspace(1, 0, fade))
        seg = slice(off, off + len(p))
        y[seg] += p[: len(y[seg])] * win[: len(y[seg])]
        w[seg] += win[: len(y[seg])]
    return y / np.maximum(w, 1e-6), 48000


ADAPTERS = {
    "ffmpeg_rnnoise": (ffmpeg_load, ffmpeg_enhance),
    "ffmpeg_afftdn": (ffmpeg_load, ffmpeg_enhance),
    "dfn3": (dfn3_load, dfn3_enhance),
    "gtcrn": (gtcrn_load, gtcrn_enhance),
    "dpdfnet2_48k": (dpdfnet_load, dpdfnet_enhance),
    "dpdfnet8_48k": (dpdfnet_load, dpdfnet_enhance),
    "sidon": (sidon_load, sidon_enhance),
}

if __name__ == "__main__":
    model = sys.argv[sys.argv.index("--model") + 1]
    load, enhance = ADAPTERS[model]
    run(load, enhance)
