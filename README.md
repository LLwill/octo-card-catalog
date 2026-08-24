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
previews and a Card Artifact as workflow artifacts.

When a new version directory is merged into `main`, `card-release` creates:

- tag `card/<card-id>/v<version>`;
- `<card-id>-<version>.artifact.json`;
- `<card-id>-<version>.artifact.sha256` with the canonical Artifact digest;
- `<card-id>-<version>.handoff.zip`;
- `<card-id>-<version>.handoff.sha256` with the ZIP byte checksum;
- `verification.json`.

Existing Card tags and Releases are never overwritten. Catalog workflows pin
GitHub Delivery Actions `github-delivery/v0.1.0`, CLI `0.2.2` and Render Profile
`1.2.0-rc.4`.

## Pilot

`docs.access-request` is the first migrated Pilot Card. Its existing `0.3.0`
version is retained as an immutable package while the root remains available for
the next draft iteration.
