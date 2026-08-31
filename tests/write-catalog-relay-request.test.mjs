import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("writes a deterministic Catalog relay request", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "octo-catalog-relay-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "catalog-relay-request.v1.json");
  const revision = "a".repeat(40);
  const transferSha256 = "b".repeat(64);

  await execFileAsync(process.execPath, [
    "scripts/write-catalog-relay-request.mjs",
    "--revision", revision,
    "--transfer-sha256", transferSha256,
    "--repository", "LLwill/octo-card-catalog",
    "--output", output,
  ], { cwd: repositoryRoot });

  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    formatVersion: 1,
    protocol: "OCTO_CATALOG_RELAY_V1",
    requestId: `catalog-${revision}`,
    repository: "LLwill/octo-card-catalog",
    revision,
    releaseTag: `catalog-snapshot/${revision}`,
    transferAsset: "catalog-transfer.tgz",
    transferChecksumAsset: "catalog-transfer.tgz.sha256",
    transferSha256,
  });
});

test("rejects invalid relay inputs", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/write-catalog-relay-request.mjs",
      "--revision", "main",
      "--transfer-sha256", "invalid",
      "--repository", "LLwill/octo-card-catalog",
      "--output", "/tmp/catalog-relay-request.v1.json",
    ], { cwd: repositoryRoot }),
    /Catalog revision must be a 40-character lowercase Git SHA/,
  );
});
