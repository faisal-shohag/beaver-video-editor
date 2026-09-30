# Third-party notices

## FFmpeg

The Windows installers ship `ffmpeg.exe` and `ffprobe.exe` as separate executables, which Beaver Video Editor runs as child processes. They are **not** covered by this project's MIT license.

- Build: Gyan.dev "full" build, version 8.1.1 (see `scripts/bundle-ffmpeg.ps1` for the exact download URL)
- License: **GNU General Public License v3.0**. This build includes GPL components such as libx264 and libx265.
- FFmpeg source code: https://ffmpeg.org/download.html and https://github.com/FFmpeg/FFmpeg
- Build configuration and sources for the bundled build: https://www.gyan.dev/ffmpeg/builds/ and https://github.com/GyanD/codexffmpeg

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

## Other components

The JavaScript and Rust dependencies (Tauri, React, Zustand, Immer, lucide-react, Tailwind CSS and others) are used under their own licenses, mostly MIT and Apache-2.0. See `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`.
