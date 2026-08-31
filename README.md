# Octo Card Catalog

GitHub-native source catalog and immutable releases for Octo Cards.

This repository contains Card Source, sample data, schemas and versioned release
packages. Compilation, validation and release asset generation are delegated to
the published Octo Card Forge CLI and reusable Actions. The Catalog does not
contain a renderer, service, database or private package dependency.

## Layout

```text
cards/
  <namespace>/
    <card-key>/
      manifest.json
      contract/
      templates/
      samples/
      goldens/
      versions/
        <version>/
```

The directory `cards/docs/access-request` maps to Card ID
`docs.access-request`. The Card root is the mutable draft. A directory under
`versions/<version>` is an immutable release candidate and its directory name
must match the exact version in `manifest.json`.

## Delivery

Pull requests run `card-check` for every changed draft or versioned Card package.
The check compiles all samples and uploads a verification report, compiled
previews, a Card Artifact, a preview-channel Catalog Snapshot and a
self-contained Forge Web entry as a workflow artifact. Download the artifact
from the workflow summary, extract it and open `preview/index.html`.

When a new version directory is merged into `main`, `card-release` creates:

- tag `card/<card-id>/v<version>`;
- `<card-id>-<version>.artifact.json`;
- `<card-id>-<version>.artifact.sha256` with the canonical Artifact digest;
- `<card-id>-<version>.handoff.zip`;
- `<card-id>-<version>.handoff.sha256` with the ZIP byte checksum;
- `verification.json`.

Existing Card tags and Releases are never overwritten. Catalog workflows pin
GitHub Delivery Actions `github-delivery/v0.2.0`, CLI `0.2.4` and Render Profile
`1.2.0-rc.4`.

After the immutable Catalog Snapshot is built, the workflow downloads and
verifies every referenced Artifact and Handoff, then publishes one immutable
Catalog Release containing:

- `catalog-snapshot.v1.json` and `catalog-snapshot.v1.sha256`;
- `catalog-transfer.tgz` and `catalog-transfer.tgz.sha256`;
- `catalog-relay-request.v1.json`, the machine-readable deployment request.

A repository `workflow_run` webhook notifies the internal OpenClaw relay after
the workflow succeeds. The relay verifies the fixed GitHub repository, workflow
run and Release assets, copies the transfer package to the Forge GitLab Generic
Package Registry, then triggers the protected Forge pipeline. GitHub does not
store internal GitLab credentials and does not need direct network access to
GitLab. See [the relay runbook](docs/openclaw-catalog-relay.md).

## Cards

The Catalog currently contains these mutable Card sources and their retained
version packages:

- `docs.access-request` - document access request;
- `ai.decision-action` - action selection and confirmation;
- `ai.reasoning-process` - reasoning progress and result states.

The Card root remains available for the next draft iteration. Directories under
`versions/` are immutable release candidates and are published by the Catalog
release workflow after merge.
