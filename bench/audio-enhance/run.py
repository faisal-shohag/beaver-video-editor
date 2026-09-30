"""Run every model over every set, measuring wall time and peak RAM of the whole process tree.

    envs/onnx/Scripts/python run.py                     # all models, all sets
    envs/onnx/Scripts/python run.py --models dfn3 gtcrn --sets vbd
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

import psutil

from registry import ADAPTERS, ENVS, MODELS

ROOT = Path(__file__).parent
SETS = ["vbd", "degraded", "real", "speed"]


def run_one(model, set_name: str, provider: str = "cpu", threads: int = 0) -> dict:
    tag = set_name if (provider, threads) == ("cpu", 0) else f"{set_name}_{provider}_t{threads}"
    out = ROOT / "out" / model.name / tag
    log = ROOT / "out" / "logs" / f"{model.name}__{tag}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(ENVS[model.env]), str(ADAPTERS[model.env]), "--model", model.name,
           "--in", str(ROOT / "data/sets" / set_name / "noisy"), "--out", str(out),
           "--provider", provider, "--threads", str(threads)]
    t0 = time.perf_counter()
    with open(log, "w", encoding="utf-8") as fh:
        proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT, cwd=ROOT)
        ps = psutil.Process(proc.pid)
        peak = 0
        while proc.poll() is None:
            try:
                rss = ps.memory_info().rss + sum(c.memory_info().rss for c in ps.children(recursive=True))
                peak = max(peak, rss)
            except psutil.Error:
                pass
            time.sleep(0.05)
    wall = time.perf_counter() - t0
    result = {"model": model.name, "set": set_name, "provider": provider, "threads": threads,
              "ok": proc.returncode == 0, "wall_secs": wall, "peak_rss_mb": peak / 2**20, "out": str(out)}
    if not result["ok"]:
        result["error"] = log.read_text(encoding="utf-8", errors="replace")[-600:]
    (out / "_run.json").parent.mkdir(parents=True, exist_ok=True)
    (out / "_run.json").write_text(json.dumps(result, indent=1))
    status = "ok" if result["ok"] else "FAILED"
    print(f"{model.name:22} {tag:18} {status:6} {wall:7.1f}s  peak {result['peak_rss_mb']:6.0f} MB", flush=True)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*")
    ap.add_argument("--sets", nargs="*", default=SETS)
    ap.add_argument("--skip-existing", action="store_true")
    args = ap.parse_args()
    models = [m for m in MODELS if not args.models or m.name in args.models]
    for m in models:
        if not ENVS[m.env].exists():
            print(f"{m.name:22} skipped: env '{m.env}' not installed")
            continue
        for s in args.sets:
            if s == "speed" and m.extra.get("slow"):
                continue
            if args.skip_existing and (ROOT / "out" / m.name / s / "_run.json").exists():
                continue
            run_one(m, s)
        if "speed" in args.sets:
            if m.extra.get("slow"):
                # RTF doesn't depend on length; a 2-minute clip keeps very slow models under the time budget.
                run_one(m, "speed_short")
                continue
            run_one(m, "speed", "cpu", 1)  # single-thread cost (e.g. while the UI or an export is busy)
            if m.dml:
                run_one(m, "speed", "dml", 0)


if __name__ == "__main__":
    main()
