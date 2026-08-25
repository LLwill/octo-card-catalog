#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ARTIFACT_MEDIA_TYPE = "application/vnd.octo.card-artifact+json;version=1";
const SHA256 = /^[a-f0-9]{64}$/;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function directories(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function discoverVersionManifests(root) {
  const manifests = [];
  for (const namespace of await directories(path.join(root, "cards"))) {
    for (const key of await directories(path.join(root, "cards", namespace))) {
      const versionsRoot = path.join(root, "cards", namespace, key, "versions");
      for (const version of await directories(versionsRoot)) {
        const relativePath = path.posix.join("cards", namespace, key, "versions", version);
        const manifest = await readJson(path.join(root, relativePath, "manifest.json"));
        const expectedId = `${namespace}.${key}`;
        if (manifest.id !== expectedId) {
          throw new Error(`${relativePath}/manifest.json id must be ${expectedId}`);
        }
        if (manifest.version !== version) {
          throw new Error(`${relativePath}/manifest.json version must be ${version}`);
        }
        manifests.push({ manifest, relativePath });
      }
    }
  }
  return manifests;
}

async function githubRequest(url, token, accept = "application/vnd.github+json") {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": "octo-card-catalog-snapshot",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${await response.text()}`);
  }
  return response;
}

function asset(release, name) {
  const matches = release.assets.filter((item) => item.name === name);
  if (matches.length !== 1) {
    throw new Error(`${release.tag_name} requires exactly one ${name} asset, found ${matches.length}`);
  }
  return matches[0];
}

async function digestFromAsset(release, name, token) {
  const value = (await (await githubRequest(asset(release, name).browser_download_url, token, "application/octet-stream")).text()).trim();
  if (!SHA256.test(value)) throw new Error(`${release.tag_name}/${name} must contain one lowercase SHA-256 digest`);
  return value;
}

async function collectReleaseRecords({ root, repository, token, apiUrl }) {
  const records = [];
  for (const { manifest, relativePath } of await discoverVersionManifests(root)) {
    const tag = `card/${manifest.id}/v${manifest.version}`;
    const releaseUrl = `${apiUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
    const release = await (await githubRequest(releaseUrl, token)).json();
    const prefix = `${manifest.id}-${manifest.version}`;
    const artifactAsset = asset(release, `${prefix}.artifact.json`);
    const handoffAsset = asset(release, `${prefix}.handoff.zip`);
    const artifactSha256 = await digestFromAsset(release, `${prefix}.artifact.sha256`, token);
    const handoffSha256 = await digestFromAsset(release, `${prefix}.handoff.sha256`, token);
    if (!/^[a-f0-9]{40}$/.test(release.target_commitish)) {
      throw new Error(`${tag} target_commitish must be an exact 40-character commit SHA`);
    }
    records.push({
      card: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        contractVersion: manifest.contractVersion,
        renderProfile: manifest.renderProfile,
        defaultLocale: manifest.defaultLocale,
      },
      artifact: {
        url: artifactAsset.browser_download_url,
        sha256: artifactSha256,
        mediaType: ARTIFACT_MEDIA_TYPE,
      },
      handoff: {
        url: handoffAsset.browser_download_url,
        sha256: handoffSha256,
      },
      source: {
        repository,
        commit: release.target_commitish,
        path: relativePath,
      },
      release: {
        tag,
        url: release.html_url,
      },
    });
  }
  return records;
}

const root = path.resolve(option("--root") ?? process.cwd());
const repository = option("--repository") ?? process.env.GITHUB_REPOSITORY;
const output = path.resolve(root, option("--output") ?? ".octo-card/catalog-release-records.json");
const apiUrl = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error("--repository or GITHUB_REPOSITORY must use owner/name");
}

const records = await collectReleaseRecords({
  root,
  repository,
  token: process.env.GITHUB_TOKEN,
  apiUrl,
});
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(records, null, 2)}\n`);
console.log(JSON.stringify({ output, repository, records: records.length }, null, 2));
