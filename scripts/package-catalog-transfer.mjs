#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_HANDOFF_BYTES = 10 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function required(name, fallback) {
  const value = option(name, fallback);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJsonValue(value, pointer = "") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${pointer || "/"} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJsonValue(item, `${pointer}/${index}`));
  if (typeof value !== "object") throw new Error(`${pointer || "/"} contains a non-JSON value`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalJsonValue(value[key], `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  ]));
}

function transferResourceBytes(reference, downloaded) {
  if (reference.kind !== "artifact") return downloaded;
  try {
    return Buffer.from(JSON.stringify(canonicalJsonValue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(downloaded)))));
  } catch (error) {
    throw new Error(`Artifact is not valid JSON for ${reference.reference}: ${error.message}`);
  }
}

function allowedOrigins() {
  return new Set(
    (process.env.CATALOG_TRANSFER_ALLOWED_ORIGINS
      ?? "https://github.com,https://objects.githubusercontent.com,https://release-assets.githubusercontent.com")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

async function download(url, maximumBytes) {
  const initialUrl = new URL(url);
  const origins = allowedOrigins();
  if (!origins.has(initialUrl.origin)) throw new Error(`Resource origin is not allowed: ${initialUrl.origin}`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(initialUrl, {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "octo-card-catalog-transfer",
          ...(process.env.GITHUB_TOKEN && initialUrl.hostname === "github.com"
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      if (!origins.has(new URL(response.url).origin)) {
        throw new Error(`Resource redirected to a disallowed origin: ${new URL(response.url).origin}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error(`Resource exceeds ${maximumBytes} bytes`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > maximumBytes) throw new Error(`Resource exceeds ${maximumBytes} bytes`);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

function writeString(target, offset, length, value) {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.byteLength > length) throw new Error(`Tar header value is too long: ${value}`);
  bytes.copy(target, offset);
}

function writeOctal(target, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeString(target, offset, length, `${encoded}\0`);
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createTar(entries) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    chunks.push(tarHeader(entry.name, entry.bytes.byteLength), entry.bytes);
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function resourceReferences(snapshot) {
  const references = [];
  for (const card of snapshot.cards ?? []) {
    for (const version of card.versions ?? []) {
      if (!version.reference || !version.artifact) throw new Error("Snapshot version is missing reference or artifact");
      references.push({ kind: "artifact", reference: version.reference, ...version.artifact, maximumBytes: MAX_ARTIFACT_BYTES });
      if (version.handoff) {
        references.push({ kind: "handoff", reference: version.reference, ...version.handoff, maximumBytes: MAX_HANDOFF_BYTES });
      }
    }
  }
  return references.sort((left, right) =>
    left.reference.localeCompare(right.reference) || left.kind.localeCompare(right.kind));
}

const snapshotPath = path.resolve(required("--snapshot", process.env.CATALOG_SNAPSHOT));
const outputPath = path.resolve(required("--output", process.env.CATALOG_TRANSFER_OUTPUT));
const catalogRevision = required("--catalog-revision", process.env.CATALOG_REVISION);
if (!REVISION.test(catalogRevision)) throw new Error("Catalog revision must be a lowercase 40-character SHA");

const snapshotBytes = await readFile(snapshotPath);
if (snapshotBytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("Catalog Snapshot exceeds 2 MiB");
const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
if (snapshot.revision !== catalogRevision) {
  throw new Error(`Snapshot revision ${snapshot.revision} does not match ${catalogRevision}`);
}

const resources = new Map();
for (const reference of resourceReferences(snapshot)) {
  if (!SHA256.test(reference.sha256)) throw new Error(`${reference.reference} has an invalid ${reference.kind} SHA-256`);
  const existing = resources.get(reference.sha256);
  if (existing) {
    existing.uses.push({ kind: reference.kind, reference: reference.reference });
    continue;
  }
  const downloaded = await download(reference.url, reference.maximumBytes);
  const bytes = transferResourceBytes(reference, downloaded);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== reference.sha256) {
    throw new Error(`${reference.kind} digest mismatch for ${reference.reference}: expected ${reference.sha256}, received ${actualSha256}`);
  }
  resources.set(reference.sha256, {
    bytes,
    uses: [{ kind: reference.kind, reference: reference.reference }],
  });
}

const resourceEntries = [...resources.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([digest, resource]) => ({
    path: `resources/${digest}`,
    sha256: digest,
    bytes: resource.bytes.byteLength,
    uses: resource.uses.sort((left, right) =>
      left.reference.localeCompare(right.reference) || left.kind.localeCompare(right.kind)),
  }));
const totalResourceBytes = resourceEntries.reduce((total, entry) => total + entry.bytes, 0);
if (snapshotBytes.byteLength + totalResourceBytes > MAX_TRANSFER_BYTES) {
  throw new Error("Catalog transfer inputs exceed 200 MiB");
}

const manifestBytes = Buffer.from(`${JSON.stringify({
  formatVersion: 1,
  catalogRevision,
  snapshot: {
    path: "catalog-snapshot.v1.json",
    sha256: sha256(snapshotBytes),
    bytes: snapshotBytes.byteLength,
  },
  resources: resourceEntries,
}, null, 2)}\n`);
const archive = gzipSync(createTar([
  { name: "catalog-snapshot.v1.json", bytes: snapshotBytes },
  { name: "transfer-manifest.json", bytes: manifestBytes },
  ...[...resources.entries()].map(([digest, resource]) => ({ name: `resources/${digest}`, bytes: resource.bytes })),
]), { level: 9, mtime: 0 });
const archiveSha256 = sha256(archive);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, archive);
await writeFile(`${outputPath}.sha256`, `${archiveSha256}  ${path.basename(outputPath)}\n`);
console.log(JSON.stringify({
  output: outputPath,
  sha256: archiveSha256,
  catalogRevision,
  resources: resourceEntries.length,
  bytes: archive.byteLength,
}, null, 2));
