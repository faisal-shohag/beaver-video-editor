"""Every benchmarked model: where it runs and what we know about shipping it."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).parent
ENVS = {
    "onnx": ROOT / "envs/onnx/Scripts/python.exe",
    "torch": ROOT / "envs/torch/Scripts/python.exe",
    "voicefixer": ROOT / "envs/voicefixer/Scripts/python.exe",
}
ADAPTERS = {
    "onnx": ROOT / "adapters/onnx_models.py",
    "torch": ROOT / "adapters/torch_models.py",
    "voicefixer": ROOT / "adapters/voicefixer_model.py",
}


@dataclass
class Model:
    name: str
    label: str
    env: str
    group: str  # shippable | reference | external
    license: str
    band: str  # native output bandwidth
    fixes: str
    size_mb: float
    runtime: str
    note: str = ""
    dml: bool = False  # also time on DirectML (AMD iGPU)
    extra: dict = field(default_factory=dict)


MODELS = [
    Model("ffmpeg_afftdn", "FFmpeg afftdn (classic DSP)", "onnx", "shippable", "LGPL/GPL (bundled FFmpeg)", "48k",
          "steady noise", 0, "FFmpeg sidecar (already bundled)"),
    Model("ffmpeg_rnnoise", "RNNoise (FFmpeg arnndn)", "onnx", "shippable", "BSD-3 (model) / FFmpeg", "48k",
          "noise", 0.3, "FFmpeg sidecar (already bundled)"),
    Model("dfn3", "DeepFilterNet3", "onnx", "shippable", "MIT / Apache-2.0", "48k", "noise", 8,
          "Rust (tract) — official deep-filter binary"),
    Model("gtcrn", "GTCRN", "onnx", "shippable", "MIT", "16k", "noise", 0.5, "ONNX (streaming)"),
    Model("dpdfnet2_48k", "DPDFNet-2 48k", "onnx", "shippable", "Apache-2.0", "48k", "noise", 10.5, "ONNX (streaming)"),
    Model("dpdfnet8_48k", "DPDFNet-8 48k", "onnx", "shippable", "Apache-2.0", "48k", "noise", 14.9, "ONNX (streaming)"),
    Model("mossformer2_onnx", "MossFormer2-SE-48K (int8 ONNX)", "torch", "shippable", "Apache-2.0", "48k", "noise", 94,
          "ONNX (int8, 4 s windows)", dml=True, note="features computed with torchaudio here; DirectML crashes on this int8 graph"),
    Model("sidon", "Sidon (int8 ONNX)", "onnx", "shippable", "MIT", "48k", "noise + reverb + bandwidth", 286,
          "ONNX (w2v-BERT predictor + DAC vocoder)", dml=True),
    Model("mossformer2_torch", "MossFormer2-SE-48K (official PyTorch)", "torch", "reference", "Apache-2.0", "48k",
          "noise", 221, "PyTorch (ClearerVoice)"),
    Model("fb_denoiser_dns64", "facebook/denoiser dns64", "torch", "reference", "CC-BY-NC 4.0 (non-commercial)", "16k",
          "noise", 128, "PyTorch"),
    Model("fb_denoiser_master64", "facebook/denoiser master64", "torch", "reference", "CC-BY-NC 4.0 (non-commercial)",
          "16k", "noise", 128, "PyTorch"),
    Model("resemble_denoise", "Resemble Enhance (denoise only)", "torch", "reference", "MIT", "44.1k", "noise", 50,
          "PyTorch"),
    Model("resemble_enhance", "Resemble Enhance (full)", "torch", "reference", "MIT", "44.1k",
          "noise + bandwidth + restoration", 360, "PyTorch", extra={"slow": True},
          note="RTF from a 2-min clip; 9 GB peak RAM"),
    Model("voicefixer", "VoiceFixer", "voicefixer", "reference", "MIT", "44.1k",
          "noise + reverb + clipping + bandwidth", 490, "PyTorch",
          note="speed run partly overlapped a Rust compile (slightly pessimistic)"),
]

# The in-app Rust ports (src-tauri/src/enhance), scored against their Python originals for parity.
PORTS = [
    Model("rust_dpdfnet2", "DPDFNet-2 48k — Rust port (in app)", "rust", "port", "Apache-2.0", "48k", "noise", 10.5,
          "Rust + ONNX Runtime (ort)"),
    Model("rust_sidon", "Sidon — Rust port (in app)", "rust", "port", "MIT", "48k", "noise + reverb + bandwidth", 286,
          "Rust + ONNX Runtime (ort)"),
]

EXTERNAL = [
    Model("adobe", "Adobe Podcast Enhance Speech", "manual", "external", "Proprietary (cloud)", "48k",
          "noise + reverb + restoration", 0, "Web service, no API"),
    Model("krisp", "Krisp", "manual", "external", "Proprietary", "48k", "noise", 0, "Desktop app (live mic)"),
    Model("nvidia_broadcast", "NVIDIA Broadcast / Maxine", "manual", "external", "Proprietary (NVIDIA RTX only)", "48k",
          "noise + echo", 0, "RTX GPU required — not runnable on this PC"),
]

BY_NAME = {m.name: m for m in MODELS + PORTS + EXTERNAL}
