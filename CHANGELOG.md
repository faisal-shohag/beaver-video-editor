# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Light and dark themes, with a System option and a toggle in the top bar. The choice is remembered and applied before first paint.
- New app icon and logo.
- Click the project name in the top bar to rename it; exports and Save As default to that name.
- Resizable Media and Inspector panels (widths are remembered) and a media grid that adds columns as the panel widens.
- Clip inspector tabs: Clip, Speed, Video and Audio.

### Changed

- Redesigned interface on shadcn/ui: floating cards, hairline borders, a zinc dark palette and a lighter light mode.
- Resolution and frame rate now sit at the bottom right of the preview.
- Selected clips on the timeline have a red-orange border.

### Fixed

- Splitting a clip no longer leaves both halves selected, and clicking one clip in a multi-selection now selects only that clip.

## [0.2.0] - 2026-09-30

### Added

- **Enhance voice:** clean up the speech on any clip, with three models chosen in a benchmark of 13 (see `bench/audio-enhance/results.md`):
  - **Fast (DeepFilterNet3):** removes background noise at about 25× real time on one CPU core. Bundled.
  - **Strong (DPDFNet-2 48 kHz):** stronger on busy real-world noise. 10 MB, downloaded on first use.
  - **Restore (Sidon):** generative restoration that removes echo and reverb and fixes phone-quality or muffled audio. 286 MB, downloaded on first use.

  Enhancement is non-destructive and cached per media file, so split clips reuse it. DeepFilterNet3 and DPDFNet-2 have Light / Medium / Full strength. You can hold a button to A/B against the original. The enhanced audio is used in preview and export, and enhanced clips show a ✦ badge and the cleaned-up waveform.
- Audio enhancer benchmark harness in `bench/audio-enhance/`, with its results.

### Changed

- Background jobs (exports, enhancements, model downloads) share one queue and one cancel command (`cancel_job`).

## [0.1.0] - 2026-09-30

First public release.

### Added

- **Multi-track timeline:** unlimited video tracks (higher tracks draw on top) and audio tracks, with mute, hide and lock per track. The timeline is drawn on a canvas with snapping, zoom and a scrollbar.
- **Cutter:** trim by dragging clip edges; cut an In/Out range out of every track with ripple (`I`, `O`, `Shift+Del`); trim to the playhead (`Q`/`W`); ripple delete.
- **Splitter:** split at the playhead (`S`, `Shift+S` for all tracks) or with the blade tool (`B`).
- **Joiner:** files dropped on the timeline are placed back to back. **Quick Join** joins files that share a format losslessly, in under a second.
- **Speed:** 0.1×–16× per clip, with presets and a "keep audio pitch" option. Clips that follow keep their position relative to the changed clip.
- **Clip controls:** volume (up to 200%), opacity, scale, position, picture-in-picture presets, and detaching audio to its own track.
- **Real-time preview:** all tracks are composited live without re-encoding. Sources above 1080p or in unsupported codecs get proxies automatically; playback is frame-accurate and supports shuttle (`J`/`K`/`L`).
- **Export engines:**
  - *Fastest*: a single pass on the fastest measured GPU encoder, or parallel chunks for VP9.
  - *Best compression*: a CPU encoder, for smaller files.
  - *Lossless copy*: no re-encoding; cuts are snapped to keyframes.
- **Encoder benchmark:** runs on first launch and picks the fastest working encoder on the machine (AMF, NVENC, QSV, x264, x265, SVT-AV1, VP9, ProRes).
- **Export options:** 12 presets (YouTube 1080p/4K, Reels/TikTok, small file, draft, HEVC, AV1, WebM, ProRes master, GIF, MP3, WAV) plus user presets. Size control by quality, bitrate or target file size. Export the whole timeline or the In→Out range. Exports run in a queue with progress, fps and time remaining.
- **Media import:** from a file picker or by dragging from Explorer, with filmstrip thumbnails and audio waveforms.
- **Projects:** `.beaver` project files, undo/redo (200 steps), crash-safe autosave with restore, and a warning before quitting with unsaved changes.
- **Installers:** Windows NSIS and MSI installers with FFmpeg bundled.

[Unreleased]: https://github.com/faisal-shohag/beaver-video-editor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/faisal-shohag/beaver-video-editor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/faisal-shohag/beaver-video-editor/releases/tag/v0.1.0
