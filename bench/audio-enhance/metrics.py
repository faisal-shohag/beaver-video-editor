"""Quality metrics. Runs in env-onnx.

Intrusive (need clean reference), computed at 16 kHz: PESQ-WB, ESTOI, SI-SDR.
Non-intrusive: DNSMOS P.835 (SIG/BAK/OVRL) and P.808, a port of Microsoft's
DNS-Challenge/DNSMOS/dnsmos_local.py using the official ONNX models.
"""
from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np
import onnxruntime as ort
import soxr
from pesq import pesq
from pystoi import stoi

MODELS = Path(__file__).parent / "models" / "dnsmos"
FS = 16000
INPUT_LENGTH = 9.01


def to16k(x: np.ndarray, sr: int) -> np.ndarray:
    return soxr.resample(x, sr, FS).astype(np.float32) if sr != FS else x.astype(np.float32)


def align(ref: np.ndarray, deg: np.ndarray, max_lag: int = 800) -> tuple[np.ndarray, np.ndarray, int]:
    """Compensate constant model latency (up to 50 ms) by cross-correlation, then trim to equal length."""
    n = min(len(ref), len(deg))
    r, d = ref[:n], deg[:n]
    corr = np.correlate(d[: min(n, FS * 4)], r[: min(n, FS * 4)], mode="full")
    mid = min(n, FS * 4) - 1
    window = corr[mid - max_lag : mid + max_lag + 1]
    lag = int(np.argmax(np.abs(window))) - max_lag
    if lag > 0:
        d = d[lag:]
        r = r[: len(d)]
    elif lag < 0:
        r = r[-lag:]
        d = d[: len(r)]
    return r, d, lag


def si_sdr(ref: np.ndarray, est: np.ndarray) -> float:
    ref = ref - ref.mean()
    est = est - est.mean()
    alpha = np.dot(est, ref) / (np.dot(ref, ref) + 1e-12)
    target = alpha * ref
    noise = est - target
    return float(10 * np.log10((np.sum(target**2) + 1e-12) / (np.sum(noise**2) + 1e-12)))


def intrusive(ref16: np.ndarray, deg16: np.ndarray) -> dict:
    r, d, lag = align(ref16, deg16)
    out = {"lag_ms": lag / FS * 1000}
    try:
        out["pesq"] = float(pesq(FS, r, d, "wb"))
    except Exception:  # pesq raises on silent / too-short input
        out["pesq"] = float("nan")
    out["estoi"] = float(stoi(r, d, FS, extended=True))
    out["si_sdr"] = si_sdr(r, d)
    return out


class DNSMOS:
    def __init__(self):
        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        self.p835 = ort.InferenceSession(str(MODELS / "sig_bak_ovr.onnx"), so, providers=["CPUExecutionProvider"])
        self.p808 = ort.InferenceSession(str(MODELS / "model_v8.onnx"), so, providers=["CPUExecutionProvider"])
        self.p_ovr = np.poly1d([-0.06766283, 1.11546468, 0.04602535])
        self.p_sig = np.poly1d([-0.08397278, 1.22083953, 0.0052439])
        self.p_bak = np.poly1d([-0.13166888, 1.60915514, -0.39604546])

    @staticmethod
    def melspec(audio: np.ndarray) -> np.ndarray:
        mel = librosa.feature.melspectrogram(y=audio, sr=FS, n_fft=321, hop_length=160, n_mels=120)
        return ((librosa.power_to_db(mel, ref=np.max) + 40) / 40).T

    def __call__(self, audio16: np.ndarray) -> dict:
        audio = audio16.astype(np.float32)
        need = int(INPUT_LENGTH * FS)
        while len(audio) < need:
            audio = np.append(audio, audio)
        hops = int(np.floor(len(audio) / FS) - INPUT_LENGTH) + 1
        rows = []
        for i in range(hops):
            seg = audio[i * FS : int((i + INPUT_LENGTH) * FS)]
            if len(seg) < need:
                continue
            sig, bak, ovr = self.p835.run(None, {self.p835.get_inputs()[0].name: seg[None, :]})[0][0]
            p808 = self.p808.run(None, {self.p808.get_inputs()[0].name: self.melspec(seg[:-160])[None].astype(np.float32)})[0][0][0]
            rows.append((self.p_sig(sig), self.p_bak(bak), self.p_ovr(ovr), p808))
        m = np.mean(rows, axis=0)
        return {"sig": float(m[0]), "bak": float(m[1]), "ovrl": float(m[2]), "p808": float(m[3])}
