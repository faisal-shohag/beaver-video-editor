# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/faisal-shohag/beaver-video-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/faisal-shohag/beaver-video-editor/releases/tag/v0.1.0
