"""Generate reference fixtures for the Rust enhance ports (src-tauri/tests/fixtures/enhance/).

Small fixtures (committed):
  sidon_in_16k.f32         1.5 s of noisy speech at 16 kHz
  sidon_feats.f32          + .json shape; SeamlessM4TFeatureExtractor output for that audio
  stft_in.f32              random signal; librosa STFT/ISTFT reference (vorbis window, win 960)
  stft_spec.f32            [frames, bins, 2]
  stft_roundtrip.f32       librosa.istft(stft(x))
  dpdfnet_in_48k.f32       3 s noisy speech at 48 kHz
  dpdfnet_out_full.f32     dpdfnet.enhance(..., attn_limit_db=None)
  dpdfnet_out_24db.f32     dpdfnet.enhance(..., attn_limit_db=24)

Run: envs/onnx/Scripts/python make_rust_fixtures.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import soxr

ROOT = Path(__file__).parent
OUT = ROOT.parent.parent / "src-tauri" / "tests" / "fixtures" / "enhance"
# Embedded by the Rust front-end (src-tauri/src/enhance/sidon.rs).
MEL_ASSET = ROOT.parent.parent / "src-tauri" / "src" / "enhance" / "assets" / "w2vbert_mel_257x80.f32"


def save(name: str, arr: np.ndarray) -> None:
    arr = np.ascontiguousarray(arr, dtype=np.float32)
    (OUT / f"{name}.f32").write_bytes(arr.tobytes())
    (OUT / f"{name}.json").write_text(json.dumps({"shape": list(arr.shape)}))
    print(f"{name:22} {arr.shape}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    clip = sorted((ROOT / "data/sets/vbd/noisy").glob("*.wav"))[3]
    x48, sr = sf.read(clip, dtype="float32")
    assert sr == 48000

    # --- Sidon / w2v-BERT front-end
    from transformers import SeamlessM4TFeatureExtractor

    fe = SeamlessM4TFeatureExtractor.from_pretrained("facebook/w2v-bert-2.0")
    MEL_ASSET.write_bytes(np.ascontiguousarray(fe.mel_filters, dtype=np.float32).tobytes())
    x16 = soxr.resample(x48, 48000, 16000)[: int(1.5 * 16000)].astype(np.float32)
    save("sidon_in_16k", x16)
    feats = fe(x16, sampling_rate=16000, return_tensors="np")["input_features"][0]
    save("sidon_feats", feats)

    # --- STFT/ISTFT matching dpdfnet/audio.py (librosa, center=True, reflect)
    from dpdfnet.audio import make_stft_config

    cfg = make_stft_config(960)
    rng = np.random.default_rng(7)
    sig = rng.standard_normal(9600).astype(np.float32) * 0.1
    save("stft_in", sig)
    spec = librosa.stft(sig, n_fft=960, hop_length=480, win_length=960, window=cfg.window, center=True, pad_mode="reflect")
    save("stft_spec", np.stack([spec.real.T, spec.imag.T], axis=-1))
    save("stft_roundtrip", librosa.istft(spec, hop_length=480, win_length=960, window=cfg.window, center=True))

    # --- DPDFNet-2 48k end-to-end
    os.environ["DPDFNET_MODEL_DIR"] = str(ROOT / "models/dpdfnet")
    import dpdfnet

    d48 = x48[: 3 * 48000]
    save("dpdfnet_in_48k", d48)
    save("dpdfnet_out_full", dpdfnet.enhance(d48, 48000, model="dpdfnet2_48khz_hr"))
    save("dpdfnet_out_24db", dpdfnet.enhance(d48, 48000, model="dpdfnet2_48khz_hr", attn_limit_db=24.0))


if __name__ == "__main__":
    main()
