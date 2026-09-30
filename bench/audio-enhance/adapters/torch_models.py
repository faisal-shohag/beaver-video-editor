"""Adapters run in env-torch (Python 3.11, CPU PyTorch).

Models: mossformer2_torch, mossformer2_onnx, fb_denoiser_dns64, fb_denoiser_master64,
        resemble_denoise, resemble_enhance
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from common import MODELS, ROOT, fit_length, ort_session, resample, run  # noqa: E402

import torch  # noqa: E402

torch.set_grad_enabled(False)


def set_threads(args):
    if args.threads:
        torch.set_num_threads(args.threads)


# ---------------------------------------------------------------- facebook/denoiser (Demucs)
def fb_load(args):
    set_threads(args)
    from denoiser import pretrained

    model = pretrained.dns64() if args.model.endswith("dns64") else pretrained.master64()
    return model.eval()


FB_CHUNK = 16000 * 30


def fb_enhance(model, x, sr, timer):
    x16 = resample(x, sr, 16000)
    out = []
    with timer:
        # 30 s chunks keep RAM bounded on long files (the model is fully convolutional + LSTM).
        for s in range(0, len(x16), FB_CHUNK):
            seg = torch.from_numpy(x16[s : s + FB_CHUNK])[None, None]
            out.append(model(seg)[0, 0].numpy())
    return fit_length(np.concatenate(out), len(x16)), 16000


# ---------------------------------------------------------------- ClearerVoice MossFormer2-SE-48K
def _cv_args(one_time):
    return types.SimpleNamespace(sampling_rate=48000, one_time_decode_length=one_time, decode_window=4,
                                 win_type="hamming", win_len=1920, win_inc=384, fft_len=1920, num_mels=60)


def mf_torch_load(args):
    set_threads(args)
    import os

    os.chdir(ROOT / "models")  # ClearVoice downloads checkpoints into ./checkpoints
    from clearvoice import ClearVoice

    cv = ClearVoice(task="speech_enhancement", model_names=["MossFormer2_SE_48K"])
    net = cv.models[0]
    return net


def mf_torch_enhance(net, x, sr, timer):
    from clearvoice.utils.decode import decode_one_audio_mossformer2_se_48k

    x48 = resample(x, sr, 48000)
    model = net.model if hasattr(net, "model") else net
    with timer:
        y = decode_one_audio_mossformer2_se_48k(model, "cpu", x48[None, :].astype(np.float64), _cv_args(20))
    return fit_length(np.asarray(y, np.float32), len(x48)), 48000


class OnnxMaskModel:
    """Looks like the torch model to ClearerVoice's decoder: fbanks [1, T, 180] -> [mask [1, T, 961]]."""

    FRAMES = 496

    def __init__(self, sess):
        self.sess = sess
        self.name = sess.get_inputs()[0].name

    def __call__(self, fbanks):
        f = fbanks.numpy().astype(np.float32)
        t = f.shape[1]
        if t < self.FRAMES:
            f = np.pad(f, ((0, 0), (0, self.FRAMES - t), (0, 0)))
        mask = self.sess.run(None, {self.name: f[:, : self.FRAMES]})[0][:, :t]
        return [torch.from_numpy(mask)]


def mf_onnx_load(args):
    return OnnxMaskModel(ort_session(MODELS / "mossformer2" / "model_int8.onnx", args.provider, args.threads))


def mf_onnx_enhance(model, x, sr, timer):
    from clearvoice.utils.decode import decode_one_audio_mossformer2_se_48k

    x48 = resample(x, sr, 48000)
    n = len(x48)
    if n < 192000:  # the export has a fixed 4 s window
        x48 = np.pad(x48, (0, 192000 - n))
    with timer:
        # one_time_decode_length=0 forces the 4 s sliding-window path that matches the ONNX shape.
        y = decode_one_audio_mossformer2_se_48k(model, "cpu", x48[None, :].astype(np.float64), _cv_args(0))
    return fit_length(np.asarray(y, np.float32), n), 48000


# ---------------------------------------------------------------- Resemble Enhance
def _stub_deepspeed():
    """deepspeed is only used for training and doesn't build on Windows; stub it for inference."""

    class _Any:
        def __init__(self, *a, **k):
            pass

        def __getattr__(self, name):
            return _Any()

        def __call__(self, *a, **k):
            return _Any()

    for name in ["deepspeed", "deepspeed.accelerator", "deepspeed.runtime", "deepspeed.runtime.engine",
                 "deepspeed.runtime.utils"]:
        mod = types.ModuleType(name)
        mod.DeepSpeedConfig = _Any
        mod.DeepSpeedEngine = _Any
        mod.get_accelerator = _Any()
        mod.clip_grad_norm_ = _Any()
        mod.__getattr__ = lambda attr: _Any()
        sys.modules[name] = mod


def resemble_load(args):
    set_threads(args)
    _stub_deepspeed()
    import pathlib

    if sys.platform == "win32":  # checkpoints pickle Linux paths
        pathlib.PosixPath = pathlib.WindowsPath
    from omegaconf import OmegaConf

    import yaml

    load_yaml = OmegaConf.load
    OmegaConf.load = lambda f, *a, **k: load_yaml(str(f), *a, **k)  # it rejects WindowsPath here
    # The published hparams pickle Linux paths (!!python/object/apply:pathlib.PosixPath); read them as strings.
    yaml.SafeLoader.add_constructor(
        "tag:yaml.org,2002:python/object/apply:pathlib.PosixPath",
        lambda loader, node: "/".join(loader.construct_sequence(node)),
    )
    from resemble_enhance.enhancer import inference as inf

    # Warm up so model download/load isn't counted as per-file time.
    x = torch.zeros(44100)
    (inf.denoise if args.model == "resemble_denoise" else inf.enhance)(x, 44100, "cpu")
    return args.model, inf


def resemble_enhance(state, x, sr, timer):
    mode, inf = state
    wav = torch.from_numpy(x.astype(np.float32))
    with timer:
        if mode == "resemble_denoise":
            y, out_sr = inf.denoise(wav, sr, "cpu")
        else:
            y, out_sr = inf.enhance(wav, sr, "cpu", nfe=64, solver="midpoint", lambd=0.9, tau=0.5)
    return y.numpy(), out_sr


ADAPTERS = {
    "fb_denoiser_dns64": (fb_load, fb_enhance),
    "fb_denoiser_master64": (fb_load, fb_enhance),
    "mossformer2_torch": (mf_torch_load, mf_torch_enhance),
    "mossformer2_onnx": (mf_onnx_load, mf_onnx_enhance),
    "resemble_denoise": (resemble_load, resemble_enhance),
    "resemble_enhance": (resemble_load, resemble_enhance),
}

if __name__ == "__main__":
    model = sys.argv[sys.argv.index("--model") + 1]
    load, enhance = ADAPTERS[model]
    run(load, enhance)
