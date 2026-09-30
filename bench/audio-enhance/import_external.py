"""Import results from a manual tool (Adobe Podcast, Krisp) into external/<tool>/<set>/<clip>.wav.

    envs/onnx/Scripts/python import_external.py adobe "C:/Users/me/Downloads/adobe-results"

Files are matched to the pack in external/input/ by name, so download names like
"vbd__p232_001 (enhanced).wav" or "vbd__p232_001-enhanced-v2.mp3" are fine. Any format FFmpeg reads works.
Adobe/Krisp may add latency or change length; score.py aligns up to 50 ms and trims.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
PACK = ROOT / "external" / "input"


def key(name: str) -> str:
    stem = Path(name).stem.lower()
    stem = re.sub(r"[\s_-]*\(?(enhanced|enhance|krisp|clean(ed)?)\)?([\s_-]*v\d+)?$", "", stem)
    return re.sub(r"[^a-z0-9]", "", stem)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    tool, src = sys.argv[1], Path(sys.argv[2])
    pack = {key(p.name): p.name for p in PACK.glob("*.wav")}
    found = 0
    for f in sorted(src.iterdir()):
        k = key(f.name)
        match = pack.get(k) or next((v for kk, v in pack.items() if kk in k or k in kk), None)
        if not match:
            print(f"skip (no matching clip): {f.name}")
            continue
        set_name, clip = match.split("__", 1)
        dst = ROOT / "external" / tool / set_name / clip
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(f), "-ac", "1", "-ar", "48000", str(dst)], check=True)
        found += 1
        print(f"{f.name} -> {dst.relative_to(ROOT)}")
    print(f"imported {found}/{len(pack)} clips for {tool}")


if __name__ == "__main__":
    main()
