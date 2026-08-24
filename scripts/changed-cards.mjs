#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);

function value(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const requestedBase = value("--base");
const head = value("--head");
const mode = value("--mode") ?? "check";

if (!requestedBase || !head) {
  throw new Error("--base and --head are required");
}
if (mode !== "check" && mode !== "release") {
  throw new Error("--mode must be check or release");
}

const base = /^0+$/.test(requestedBase) ? `${head}^` : requestedBase;
const changed = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--", "cards"],
  { encoding: "utf8" }
).trim();
const semver = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const roots = new Set();

for (const file of changed ? changed.split("\n") : []) {
  const parts = file.split("/");
  if (parts.length < 4 || parts[0] !== "cards") continue;

  const draftRoot = parts.slice(0, 3).join("/");
  const isVersion = parts[3] === "versions" && semver.test(parts[4] ?? "");
  if (mode === "release") {
    if (isVersion) roots.add(parts.slice(0, 5).join("/"));
  } else {
    roots.add(isVersion ? parts.slice(0, 5).join("/") : draftRoot);
  }
}

console.log(JSON.stringify([...roots].sort()));
