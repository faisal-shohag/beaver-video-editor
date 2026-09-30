"""VoiceFixer adapter (env-voicefixer, Python 3.9). General speech restoration at 44.1 kHz."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from common import fit_length, resample, run  # noqa: E402


def load(args):
    import torch

    if args.threads:
        torch.set_num_threads(args.threads)
    from voicefixer import VoiceFixer

    return VoiceFixer()


def enhance(vf, x, sr, timer):
    x44 = resample(x, sr, 44100)
    with timer:
        # mode 0 = the published default restoration.
        y = vf.restore_inmem(x44, cuda=False, mode=0)
    return fit_length(np.asarray(y, np.float32).reshape(-1), len(x44)), 44100


if __name__ == "__main__":
    run(load, enhance)
