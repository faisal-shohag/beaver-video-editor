"""Shared adapter plumbing. Runs in every env (Python 3.9+), so keep it dependency-light.

An adapter is invoked as:
    python adapters/<file>.py --model NAME --in DIR --out DIR [--provider cpu|dml] [--threads N]
It writes one enhanced WAV per input (same file name) plus DIR/_timing.json:
    {"model": ..., "load_secs": ..., "out_sr": ..., "files": {name: {"secs": ..., "compute_secs": ...}}}
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--provider", default="cpu", choices=["cpu", "dml"])
    ap.add_argument("--threads", type=int, default=0, help="0 = all cores")
    return ap.parse_args()


def read_mono(path, target_sr=None):
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if target_sr and sr != target_sr:
        x = resample(x, sr, target_sr)
        sr = target_sr
    return x, sr


def resample(x, sr_in, sr_out):
    if sr_in == sr_out:
        return x
    try:
        import soxr

        return soxr.resample(x, sr_in, sr_out).astype(np.float32)
    except ImportError:  # older envs
        import librosa

        return librosa.resample(x, orig_sr=sr_in, target_sr=sr_out).astype(np.float32)


class Timer:
    """Accumulates time spent in model inference (excludes file IO / resampling)."""

    def __init__(self):
        self.total = 0.0

    def __enter__(self):
        self._t = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.total += time.perf_counter() - self._t


def run(load_fn, enhance_fn, out_sr_hint=None):
    """load_fn(args) -> state; enhance_fn(state, wav, sr, timer) -> (wav, sr)."""
    args = parse_args()
    # Absolute paths: some loaders chdir (e.g. ClearVoice downloads into ./checkpoints).
    inp, out = Path(args.inp).resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    state = load_fn(args)
    load_secs = time.perf_counter() - t0
    files = {}
    out_sr = out_sr_hint
    for f in sorted(inp.glob("*.wav")):
        x, sr = read_mono(f)
        timer = Timer()
        t = time.perf_counter()
        y, out_sr = enhance_fn(state, x, sr, timer)
        secs = time.perf_counter() - t
        y = np.nan_to_num(np.asarray(y, dtype=np.float32).reshape(-1))
        sf.write(str(out / f.name), y, out_sr, subtype="FLOAT")
        files[f.name] = {"secs": secs, "compute_secs": timer.total or secs, "in_secs": len(x) / sr}
    (out / "_timing.json").write_text(
        json.dumps({"model": args.model, "provider": args.provider, "threads": args.threads,
                    "load_secs": load_secs, "out_sr": out_sr, "files": files}, indent=1)
    )


def ort_session(path, provider="cpu", threads=0):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if threads:
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
    providers = ["DmlExecutionProvider", "CPUExecutionProvider"] if provider == "dml" else ["CPUExecutionProvider"]
    if provider == "dml":
        import os

        # Some int8 graphs crash DirectML's graph fusion; BENCH_DML_NO_OPT=1 retries unoptimised.
        if os.environ.get("BENCH_DML_NO_OPT"):
            so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        so.enable_mem_pattern = False
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return ort.InferenceSession(str(path), sess_options=so, providers=providers)


def fit_length(y, n):
    return y[:n] if len(y) >= n else np.pad(y, (0, n - len(y)))
