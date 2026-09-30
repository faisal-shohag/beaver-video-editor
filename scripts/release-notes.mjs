#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version (used by the release workflow).
//   node scripts/release-notes.mjs 0.1.0
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const start = changelog.search(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m"));
if (start < 0) {
  console.error(`No CHANGELOG.md entry for ${version}`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.slice(1).search(/^## \[/m);
const section = (next < 0 ? rest : rest.slice(0, next + 1)).split("\n").slice(1).join("\n");
// Drop link reference definitions ("[0.1.0]: https://…") that belong to the whole file.
console.log(section.replace(/^\[[^\]]+\]: .*$/gm, "").trim());
