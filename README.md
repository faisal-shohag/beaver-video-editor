# Beaver Video Editor

[![CI](https://github.com/faisal-shohag/beaver-video-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/faisal-shohag/beaver-video-editor/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/faisal-shohag/beaver-video-editor?sort=semver)](https://github.com/faisal-shohag/beaver-video-editor/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A fast, simple multi-track video editor for Windows. It covers cutting, splitting, joining and speed changes, and exports through FFmpeg using the fastest encoder it measures on your PC.

**Stack:** Tauri 2 (Rust) · React 19 + TypeScript · Vite · Tailwind CSS v4 · Zustand + Immer · FFmpeg 8 (bundled sidecar)

## Download

Download the latest installer from **[Releases](https://github.com/faisal-shohag/beaver-video-editor/releases/latest)**:

- `Beaver-Video-Editor_<version>_x64-setup.exe`: recommended. Installs per user; no admin rights needed.
- `Beaver-Video-Editor_<version>_x64_en-US.msi`: for managed or IT deployments.

Requires Windows 10 or 11 (x64). FFmpeg is bundled. The installers aren't code-signed yet, so SmartScreen may warn: choose **More info → Run anyway**. Each release includes a `SHA256SUMS.txt` for verifying the download.

## Features

| | |
|---|---|
| **Cutter** | Drag clip edges to trim. Mark In (`I`) / Out (`O`), then `Shift+Del` cuts the range out of every track and closes the gap. `Q` / `W` trim to the playhead. |
| **Splitter** | `S` splits at the playhead (selected clips, or every track when nothing is selected). `Shift+S` splits all tracks. The blade tool (`B`) splits wherever you click. |
| **Joiner** | Drop several files onto an empty timeline and they are placed back to back. **Quick Join** (`Ctrl+J`) joins files with the same format losslessly in well under a second. |
| **Speed** | Each clip can run at 0.1×–16×, with presets and a "keep audio pitch" option. Later clips stay butted up against it. |
| **Multi-track** | Any number of video tracks (higher tracks draw on top) and audio tracks. Tracks can be muted, hidden or locked. Clips support opacity, scale, position and PiP presets, and audio can be detached. |
| **Preview** | Real-time composited preview with no re-encoding. Sources above 1080p (or in codecs the webview can't play) automatically get a lightweight proxy for smooth scrubbing. |
| **Export** | Three engines: **Fastest**, **Best compression** and **Lossless copy**. 12 presets (YouTube, Reels/TikTok, small file, HEVC, AV1, WebM, ProRes master, GIF, MP3, WAV) plus your own saved presets. Size control by quality, bitrate or target file size. Export the whole timeline or the In→Out range. Multiple exports run in a queue with progress, fps and time remaining. |
| **Safety** | Undo/redo (200 steps), `.beaver` project files, crash-safe autosave with restore, and a warning before quitting with unsaved changes. |

## Export engines (measured on the target PC)

The app benchmarks every available encoder on first launch using a noisy 1080p test clip. The results are cached in `%APPDATA%\com.beaver.videoeditor\encoders.json`; click the GPU chip in the top bar to re-run the benchmark.

Test machine: Ryzen 7 7700, AMD Radeon iGPU (AMF), 50 s multi-track 1080p timeline.

| Engine | What it does | H.264 | HEVC |
|---|---|---|---|
| **Fastest** | Single pass on the fastest hardware encoder. VP9 uses parallel chunks instead. | 6.3 s (h264_amf) | **5.5 s** (hevc_amf) |
| **Best compression** | CPU encoder: about 27% smaller files at the same quality | 6.6 s (libx264) | 12.1 s (libx265) |
| **Lossless copy** | No re-encode; each cut starts on the nearest earlier keyframe | 0.3 s | 0.3 s |

Why there's no CPU+GPU "turbo" split: chunking a timeline across processes, or splitting it between the CPU and the GPU, was measured to be **no faster** than a single pass for H.264, HEVC, AV1 or ProRes on this machine. x264 already uses all 16 threads, and the iGPU encoder is its own bottleneck. Chunking only paid off for VP9 (20.7 s → 13.3 s), so it's used there only.

## Development

Requirements: Node 20+, pnpm, Rust (MSVC toolchain), FFmpeg on `PATH` (`winget install Gyan.FFmpeg`).

```powershell
pnpm install
pnpm ffmpeg:bundle        # copy ffmpeg/ffprobe from PATH into src-tauri/binaries (sidecars)
                          # or: pnpm ffmpeg:bundle -Download  (pinned build, same as CI)
pnpm tauri dev            # dev server on :3417 (1420 is in a Windows-reserved port range here)
pnpm tauri build          # release build + NSIS/MSI installers in src-tauri/target/release/bundle
```

Tests:

```powershell
pnpm test                               # timeline edit operations (Vitest)
pnpm typecheck
cd src-tauri; cargo test                # graph builder, probe, progress + real FFmpeg renders
```

The Rust integration tests in `src-tauri/tests/render.rs` render generated media through real FFmpeg. They check output durations and that the output decodes cleanly: cut/join, speed changes, multi-track PiP with music, the AMF encoder, lossless copy (including B-frame sources) and chunked encoding.

### Driving the real app in tests

WebView2 can expose DevTools, which lets Playwright drive the actual Tauri window:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
pnpm tauri dev
# then: chromium.connectOverCDP("http://localhost:9222")
```

Dev builds expose `window.__beaver` (the importer, stores and jobs) so scripts can import media without native file dialogs.

Set `BEAVER_KEEP_EXPORT_TMP=1` to keep the filter graphs and chunks from each export (they live in the app cache under `export-tmp`). To print the FFmpeg command for a saved project, run `cargo run --example plan -- project.json settings.json`.

## Architecture

```
src/
  app/            layout, top bar, shortcuts, actions (commands shared by keys/menus)
  store/          ops.ts (pure timeline edits + tests), project (undo history), ui, runtime
  features/
    media-bin/    import pipeline: probe → thumbnails / waveform / proxy (background queues)
    preview/      engine.ts: hidden <video> pool + canvas compositor, clock slaved to video
    timeline/     canvas renderer + pointer interactions (trim, move, snap, blade, drop)
    inspector/    speed, volume, opacity/scale/position
    export/       dialog, presets, job queue
    join/         Quick Join (lossless)
src-tauri/src/
  ffmpeg/graph.rs    timeline → filter_complex (pure, golden-tested)
  ffmpeg/probe.rs    ffprobe → MediaInfo, keyframe index
  commands/media.rs  probe, proxies, filmstrip sprites, waveform peaks (cached)
  commands/encoders.rs  encoder discovery + benchmark
  commands/export.rs    render / copy / chunked jobs, progress events, cancel
```

**How the render graph is built:** each video track becomes one `concat` of its clip segments and gap fillers, so a single-track edit never needs an `overlay`. The lowest track with content is the opaque base; tracks above it get an alpha channel and are overlaid on top. Each clip gets its own input with `-ss`/`-t`, so only the part that's used gets decoded. Audio clips are retimed with `atempo` (or `asetrate` when pitch isn't kept), delayed to their position with `adelay`, and summed with `amix`. Exports always read the original files, never the proxies.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the release process, and [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## License

Beaver Video Editor is [MIT licensed](LICENSE).

The bundled FFmpeg binaries are a separate program under the GPL-3.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The two sidecars take about 450 MB uncompressed (113 MB inside the NSIS installer).
