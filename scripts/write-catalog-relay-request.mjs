#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function required(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required argument: ${name}`);
  return value;
}

const revision = required("--revision");
const transferSha256 = required("--transfer-sha256");
const repository = required("--repository");
const outputPath = path.resolve(required("--output"));

if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Catalog revision must be a 40-character lowercase Git SHA");
if (!/^[0-9a-f]{64}$/.test(transferSha256)) throw new Error("Transfer SHA-256 must be 64 lowercase hexadecimal characters");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Repository must be in owner/name form");

const request = {
  formatVersion: 1,
  protocol: "OCTO_CATALOG_RELAY_V1",
  requestId: `catalog-${revision}`,
  repository,
  revision,
  releaseTag: `catalog-snapshot/${revision}`,
  transferAsset: "catalog-transfer.tgz",
  transferChecksumAsset: "catalog-transfer.tgz.sha256",
  transferSha256,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(request, null, 2)}\n`);
console.log(JSON.stringify(request));
