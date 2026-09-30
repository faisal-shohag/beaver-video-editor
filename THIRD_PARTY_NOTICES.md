# Third-party notices

## FFmpeg

The Windows installers ship `ffmpeg.exe` and `ffprobe.exe` as separate executables, which Beaver Video Editor runs as child processes. They are **not** covered by this project's MIT license.

- Build: Gyan.dev "full" build, version 8.1.1 (see `scripts/bundle-ffmpeg.ps1` for the exact download URL)
- License: **GNU General Public License v3.0**. This build includes GPL components such as libx264 and libx265.
- FFmpeg source code: https://ffmpeg.org/download.html and https://github.com/FFmpeg/FFmpeg
- Build configuration and sources for the bundled build: https://www.gyan.dev/ffmpeg/builds/ and https://github.com/GyanD/codexffmpeg

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

## Voice enhancement models and runtime

Speech-enhancement models, each covered by its own licence:

| Component | Licence | How it ships |
|---|---|---|
| [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) `deep-filter` v0.5.6 | MIT / Apache-2.0 | Bundled executable (sidecar) |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) 1.28.2 | MIT | Bundled `onnxruntime.dll` |
| [DPDFNet](https://github.com/ceva-ip/DPDFNet) `dpdfnet2_48khz_hr` (Ceva) | Apache-2.0 | Downloaded on first use from Hugging Face `Ceva-IP/DPDFNet` (pinned revision, SHA-256 verified) |
| [Sidon](https://github.com/sarulab-speech/Sidon) int8 ONNX export ([soniqo/Sidon-ONNX](https://huggingface.co/soniqo/Sidon-ONNX)); built on w2v-BERT 2.0 and the DAC decoder | MIT | Downloaded on first use (pinned revision, SHA-256 verified) |

The w2v-BERT 2.0 mel filterbank in `src-tauri/src/enhance/assets/` is exported from Hugging Face `transformers` (Apache-2.0).

## Other components

The JavaScript and Rust dependencies (Tauri, React, Zustand, Immer, lucide-react, Tailwind CSS and others) are used under their own licenses, mostly MIT and Apache-2.0. See `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`.
