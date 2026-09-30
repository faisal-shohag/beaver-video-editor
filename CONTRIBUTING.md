# Contributing to Beaver Video Editor

Thanks for helping out! Bug reports, feature ideas and pull requests are all welcome.

## Getting started

Requirements: Windows 10/11, Node 22+, pnpm, Rust (stable, MSVC toolchain), and the WebView2 runtime (preinstalled on Windows 11).

```powershell
git clone https://github.com/faisal-shohag/beaver-video-editor.git
cd beaver-video-editor
pnpm install
pnpm ffmpeg:bundle -Download   # or `pnpm ffmpeg:bundle` to copy the FFmpeg on your PATH
pnpm tauri dev
```

## Before you open a pull request

Run the same checks CI runs:

```powershell
pnpm typecheck
pnpm test
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test          # includes real FFmpeg renders; needs ffmpeg on PATH
```

- Keep changes focused: one fix or feature per PR.
- Add tests with your change. Timeline edits belong in `src/store/ops.test.ts`. FFmpeg graph changes need a golden test in `src-tauri/src/ffmpeg/graph.rs`, and a real render in `src-tauri/tests/render.rs` if the output changes.
- If you change the project model, update both `src/lib/types.ts` and `src-tauri/src/model.rs`.
- Add a line to the `## [Unreleased]` section of `CHANGELOG.md`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(timeline): add ripple trim
fix(export): keep audio in sync after speed change
docs: explain proxy settings
```

Common types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci` and `chore`.

## Releases (maintainers)

Versions follow [Semantic Versioning](https://semver.org/). To cut a release:

```powershell
pnpm bump 0.2.0                      # updates package.json, Cargo.toml, tauri.conf.json, Cargo.lock
# move the Unreleased notes in CHANGELOG.md under "## [0.2.0] - YYYY-MM-DD" and update the compare links
git commit -am "chore(release): v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --follow-tags
```

Pushing a `v*` tag runs the **Release** workflow. It builds the NSIS and MSI installers, then publishes a GitHub Release using that version's `CHANGELOG.md` notes, with SHA-256 checksums attached.
