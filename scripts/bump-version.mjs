#!/usr/bin/env node
// Sets the app version everywhere it lives: package.json, src-tauri/Cargo.toml,
// src-tauri/tauri.conf.json (and refreshes Cargo.lock).
//
//   pnpm bump 0.2.0
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: pnpm bump <major.minor.patch[-prerelease]>");
  process.exit(1);
}

const edit = (file, fn) => {
  const path = join(root, file);
  writeFileSync(path, fn(readFileSync(path, "utf8")));
  console.log(`updated ${file}`);
};

edit("package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
// Only the [package] version (first `version =` line), not dependency versions.
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));
execSync("cargo update -p beaver-video-editor --offline", { cwd: join(root, "src-tauri"), stdio: "inherit" });

console.log(`\nVersion set to ${version}. Next:
  1. Move the "Unreleased" notes in CHANGELOG.md under "## [${version}]"
  2. git commit -am "chore(release): v${version}"
  3. git tag -a v${version} -m "v${version}" && git push origin main --follow-tags`);
