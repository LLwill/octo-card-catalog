import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    offset += 512;
    entries.set(name, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "octo-catalog-transfer-"));
  const artifact = Buffer.from('{"formatVersion":1}\n');
  const canonicalArtifact = Buffer.from('{"formatVersion":1}');
  const handoff = Buffer.from("handoff bytes\n");
  const revision = "a".repeat(40);
  const server = createServer((request, response) => {
    const body = request.url === "/artifact" ? artifact : request.url === "/handoff" ? handoff : undefined;
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Length": body.byteLength });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const snapshot = {
    formatVersion: 1,
    revision,
    cards: [{
      versions: [{
        reference: "example.notice@1.0.0",
        artifact: { url: `${origin}/artifact`, sha256: sha256(canonicalArtifact) },
        handoff: { url: `${origin}/handoff`, sha256: sha256(handoff) },
      }],
    }],
  };
  const snapshotPath = path.join(root, "catalog-snapshot.v1.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { root, server, origin, revision, snapshotPath, artifact, canonicalArtifact, handoff };
}

test("creates a deterministic, content-addressed Catalog transfer archive", async (context) => {
  const input = await fixture();
  context.after(async () => {
    await new Promise((resolve) => input.server.close(resolve));
    await rm(input.root, { recursive: true, force: true });
  });
  const first = path.join(input.root, "first.tgz");
  const second = path.join(input.root, "second.tgz");
  const args = (output) => [
    "scripts/package-catalog-transfer.mjs",
    "--snapshot", input.snapshotPath,
    "--catalog-revision", input.revision,
    "--output", output,
  ];
  const env = { ...process.env, CATALOG_TRANSFER_ALLOWED_ORIGINS: input.origin };
  await execFileAsync(process.execPath, args(first), { cwd: path.resolve(import.meta.dirname, ".."), env });
  await execFileAsync(process.execPath, args(second), { cwd: path.resolve(import.meta.dirname, ".."), env });

  const firstBytes = await readFile(first);
  assert.deepEqual(firstBytes, await readFile(second));
  assert.equal(await readFile(`${first}.sha256`, "utf8"), `${sha256(firstBytes)}  first.tgz\n`);
  const entries = tarEntries(firstBytes);
  assert.deepEqual([...entries.keys()].sort(), [
    "catalog-snapshot.v1.json",
    `resources/${sha256(input.handoff)}`,
    `resources/${sha256(input.canonicalArtifact)}`,
    "transfer-manifest.json",
  ]);
  assert.deepEqual(entries.get(`resources/${sha256(input.canonicalArtifact)}`), input.canonicalArtifact);
  assert.deepEqual(entries.get(`resources/${sha256(input.handoff)}`), input.handoff);
  const manifest = JSON.parse(entries.get("transfer-manifest.json").toString("utf8"));
  assert.equal(manifest.catalogRevision, input.revision);
  assert.deepEqual(manifest.resources.map((resource) => resource.sha256), [sha256(input.canonicalArtifact), sha256(input.handoff)].sort());
});

test("rejects a resource whose bytes do not match the Snapshot digest", async (context) => {
  const input = await fixture();
  context.after(async () => {
    await new Promise((resolve) => input.server.close(resolve));
    await rm(input.root, { recursive: true, force: true });
  });
  const snapshot = JSON.parse(await readFile(input.snapshotPath, "utf8"));
  snapshot.cards[0].versions[0].artifact.sha256 = "f".repeat(64);
  await writeFile(input.snapshotPath, `${JSON.stringify(snapshot)}\n`);

  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/package-catalog-transfer.mjs",
      "--snapshot", input.snapshotPath,
      "--catalog-revision", input.revision,
      "--output", path.join(input.root, "invalid.tgz"),
    ], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, CATALOG_TRANSFER_ALLOWED_ORIGINS: input.origin },
    }),
    /artifact digest mismatch/,
  );
});
