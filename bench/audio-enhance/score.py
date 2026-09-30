"""Score every finished run and write results.json, results.md and listen.html.

    envs/onnx/Scripts/python score.py
"""
from __future__ import annotations

import html
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import soundfile as sf

import metrics
from registry import BY_NAME, EXTERNAL, MODELS, PORTS

ROOT = Path(__file__).parent
SETS = ROOT / "data/sets"
OUT = ROOT / "out"
QUALITY_SETS = ["vbd", "degraded", "real"]

_dnsmos = None


def _load16(path: Path) -> np.ndarray:
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    return metrics.to16k(x.mean(axis=1), sr)


def score_file(task: tuple[str, str, str | None]) -> dict:
    global _dnsmos
    if _dnsmos is None:
        _dnsmos = metrics.DNSMOS()
    name, deg_path, ref_path = task
    deg = _load16(Path(deg_path))
    row = {"file": name, **_dnsmos(deg)}
    if ref_path:
        row.update(metrics.intrusive(_load16(Path(ref_path)), deg))
    return row


def score_dir(set_name: str, deg_dir: Path, pool: ProcessPoolExecutor) -> list[dict]:
    """Per-file scores for one model/set, cached next to the outputs."""
    cache = deg_dir / "_scores.json"
    wavs = sorted(deg_dir.glob("*.wav"))
    if cache.exists() and cache.stat().st_mtime > max((w.stat().st_mtime for w in wavs), default=0):
        return json.loads(cache.read_text())
    clean = SETS / set_name / "clean"
    tasks = [(w.name, str(w), str(clean / w.name) if (clean / w.name).exists() else None) for w in wavs]
    rows = list(pool.map(score_file, tasks, chunksize=2))
    cache.write_text(json.dumps(rows))
    return rows


def mean(rows: list[dict], key: str) -> float | None:
    vals = [r[key] for r in rows if key in r and r[key] == r[key]]
    return float(np.mean(vals)) if vals else None


def summarize(rows: list[dict]) -> dict:
    return {k: mean(rows, k) for k in ("pesq", "estoi", "si_sdr", "sig", "bak", "ovrl", "p808")}


def speed_stats(model: str) -> dict:
    out = {}
    for tag, key in [("speed", "cpu"), ("speed_short", "cpu"), ("speed_cpu_t1", "cpu_1t"), ("speed_dml_t0", "dml")]:
        d = OUT / model / tag
        t, r = d / "_timing.json", d / "_run.json"
        if not t.exists():
            continue
        timing = json.loads(t.read_text())
        run = json.loads(r.read_text()) if r.exists() else {}
        files = timing["files"].values()
        audio = sum(f["in_secs"] for f in files)
        out[key] = {
            "rtf": sum(f["secs"] for f in files) / audio,
            "rtf_model": sum(f["compute_secs"] for f in files) / audio,
            "load_secs": timing["load_secs"],
            "peak_ram_mb": run.get("peak_rss_mb"),
        }
    return out


def main():
    results = {"models": {}, "baselines": {}}
    workers = max(2, (os.cpu_count() or 8) - 2)
    with ProcessPoolExecutor(workers) as pool:
        for s in QUALITY_SETS:
            base = {"input": score_dir(s, SETS / s / "noisy", pool)}
            if (SETS / s / "clean").exists():
                base["clean"] = score_dir(s, SETS / s / "clean", pool)
            results["baselines"][s] = {k: {"summary": summarize(v), "rows": v} for k, v in base.items()}
        for m in MODELS + PORTS + EXTERNAL:
            entry = {"sets": {}, "speed": speed_stats(m.name)}
            for s in QUALITY_SETS:
                d = OUT / m.name / s
                if m.group == "external":
                    d = ROOT / "external" / m.name / s
                if not d.exists() or not any(d.glob("*.wav")):
                    continue
                rows = score_dir(s, d, pool)
                entry["sets"][s] = {"summary": summarize(rows), "rows": rows}
                print(f"scored {m.name:22} {s:9} {len(rows)} clips", flush=True)
            if entry["sets"] or entry["speed"]:
                results["models"][m.name] = entry
    (ROOT / "results.json").write_text(json.dumps(results, indent=1))
    write_markdown(results)
    write_listen_page(results)
    print("wrote results.md, results.json, listen.html")


def fmt(v, digits=2):
    return "–" if v is None else f"{v:.{digits}f}"


def by_kind(rows: list[dict]) -> dict:
    kinds = {}
    for r in rows:
        kinds.setdefault(r["file"].split("__")[0], []).append(r)
    return {k: summarize(v) for k, v in kinds.items()}


def write_markdown(res: dict) -> None:
    L = ["# Audio enhancer benchmark results", "",
         "Machine: Ryzen 7 7700 (8C/16T), AMD Radeon iGPU (DirectML), 15 GB RAM. "
         "RTF = processing time ÷ audio duration (lower is faster; 0.05 = 20× faster than real time). "
         "Quality metrics are computed at 16 kHz. PESQ-WB (1–4.5), ESTOI (0–1) and SI-SDR (dB) compare against the clean reference; "
         "DNSMOS P.835 OVRL/SIG/BAK and P.808 (1–5) are reference-free MOS predictions.", ""]
    for s, title in [("vbd", "Speech + real noise (VoiceBank-DEMAND, 100 clips)"),
                     ("degraded", "Old / low-quality recordings (60 clips: phone, MP3, reverb, clipping, hum, combo)"),
                     ("real", "Real-world recordings (DNS Challenge, no reference)")]:
        L += [f"## {title}", "", "| Model | Group | PESQ | ESTOI | SI-SDR | OVRL | SIG | BAK | P.808 |",
              "|---|---|---|---|---|---|---|---|---|"]
        for label, summ in [("*(unprocessed input)*", res["baselines"][s]["input"]["summary"])] + (
            [("*(clean reference)*", res["baselines"][s]["clean"]["summary"])] if "clean" in res["baselines"][s] else []
        ):
            L.append(f"| {label} | | {fmt(summ['pesq'])} | {fmt(summ['estoi'])} | {fmt(summ['si_sdr'], 1)} | "
                     f"{fmt(summ['ovrl'])} | {fmt(summ['sig'])} | {fmt(summ['bak'])} | {fmt(summ['p808'])} |")
        ranked = sorted(((n, e) for n, e in res["models"].items() if s in e["sets"]),
                        key=lambda kv: -(kv[1]["sets"][s]["summary"]["ovrl"] or 0))
        for n, e in ranked:
            m, summ = BY_NAME[n], e["sets"][s]["summary"]
            L.append(f"| {m.label} | {m.group} | {fmt(summ['pesq'])} | {fmt(summ['estoi'])} | {fmt(summ['si_sdr'], 1)} | "
                     f"**{fmt(summ['ovrl'])}** | {fmt(summ['sig'])} | {fmt(summ['bak'])} | {fmt(summ['p808'])} |")
        L.append("")
        if s == "degraded":
            kinds = sorted(by_kind(res["baselines"][s]["input"]["rows"]))
            L += ["### Degraded set by problem (DNSMOS OVRL / PESQ)", "",
                  "| Model | " + " | ".join(kinds) + " |", "|---" * (len(kinds) + 1) + "|"]
            rows = [("*(input)*", by_kind(res["baselines"][s]["input"]["rows"]))] + [
                (BY_NAME[n].label, by_kind(e["sets"][s]["rows"])) for n, e in ranked]
            for label, bk in rows:
                L.append(f"| {label} | " + " | ".join(
                    f"{fmt(bk.get(k, {}).get('ovrl'))} / {fmt(bk.get(k, {}).get('pesq'))}" for k in kinds) + " |")
            L.append("")
    L += ["## Speed & footprint (10-minute speech file)", "",
          "| Model | Group | RTF all cores | RTF 1 thread | RTF DirectML | Peak RAM | Load | Model size | Band | Licence | Runtime |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]
    for m in MODELS + PORTS + EXTERNAL:
        sp = res["models"].get(m.name, {}).get("speed", {})
        cpu, t1, dml = sp.get("cpu", {}), sp.get("cpu_1t", {}), sp.get("dml", {})
        L.append(f"| {m.label} | {m.group} | {fmt(cpu.get('rtf'), 3)} | {fmt(t1.get('rtf'), 3)} | {fmt(dml.get('rtf'), 3)} | "
                 f"{fmt(cpu.get('peak_ram_mb'), 0)} MB | {fmt(cpu.get('load_secs'), 1)} s | {m.size_mb:g} MB | {m.band} | "
                 f"{m.license} | {m.runtime}{' — ' + m.note if m.note else ''} |")
    (ROOT / "results.md").write_text("\n".join(L) + "\n", encoding="utf-8")


def write_listen_page(res: dict) -> None:
    clips = sorted(p.name for p in (ROOT / "external/input").glob("*.wav"))
    names = [n for n in res["models"] if res["models"][n]["sets"]]
    rows = []
    for c in clips:
        set_name, file = c.split("__", 1)
        cells = [f"<td><audio controls preload=none src='data/sets/{set_name}/noisy/{file}'></audio></td>"]
        clean = SETS / set_name / "clean" / file
        cells.append(f"<td><audio controls preload=none src='data/sets/{set_name}/clean/{file}'></audio></td>"
                     if clean.exists() else "<td>–</td>")
        for n in names:
            src = (ROOT / "external" / n / set_name / file) if BY_NAME[n].group == "external" else (OUT / n / set_name / file)
            cells.append(f"<td><audio controls preload=none src='{src.relative_to(ROOT).as_posix()}'></audio></td>"
                         if src.exists() else "<td>–</td>")
        rows.append(f"<tr><th>{html.escape(c)}</th>{''.join(cells)}</tr>")
    head = "".join(f"<th>{html.escape(BY_NAME[n].label)}</th>" for n in names)
    page = f"""<!doctype html><meta charset=utf-8><title>Enhancer listening test</title>
<style>body{{font:13px system-ui;background:#111;color:#ddd;margin:16px}}table{{border-collapse:collapse}}
th,td{{border:1px solid #333;padding:4px;vertical-align:middle}}th{{background:#1b1b1f;position:sticky;top:0}}
audio{{width:180px;height:32px}}tbody th{{text-align:left;max-width:220px;word-break:break-all;font-weight:normal}}</style>
<h1>Enhancer listening test</h1><p>Use headphones. Clips: 4 speech+noise, 4 degraded, 4 real recordings.</p>
<div style=overflow:auto><table><thead><tr><th>Clip</th><th>Input</th><th>Clean ref</th>{head}</tr></thead>
<tbody>{''.join(rows)}</tbody></table></div>"""
    (ROOT / "listen.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main()
