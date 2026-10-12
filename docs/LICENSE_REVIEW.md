# License review — Workstation

Reviewed 2026-10-12. Original project code retains **MIT** terms in [LICENSE](../LICENSE).

The owner selected MIT for previously unlicensed original code. Existing licenses were preserved. This choice does not relicense copied code, dependencies, datasets, model weights, fonts, logos, or game assets.

## Preserved notices

- [LICENSE](../LICENSE)

## Dependency evidence

[DEPENDENCIES.csv](DEPENDENCIES.csv) lists 21 manifest and lockfile records. Repeated packages can appear under different manifests, versions, or development scopes. Registry metadata is evidence, not a replacement for the actual license text. For unpinned ranges, `metadata_version` is the version inspected and is not a claim about every install. Go and system/build tools can require notices beyond package-manager metadata.

| Component | Declared version | License evidence |
| --- | --- | --- |
| npm: yazl | ^3.3.1 | [MIT](https://registry.npmjs.org/yazl/latest) |
| npm: @playwright/test | ^1.63.0 | [Apache-2.0](https://registry.npmjs.org/%40playwright%2Ftest/latest) |
| npm: electron | ^44.5.1 | [MIT](https://registry.npmjs.org/electron/latest) |

## Project-specific considerations

Electron includes Chromium/Node components with additional notices in binary distributions. yazl and its dependencies have separate terms. scripts/download-relay.mjs downloads Cloudflare cloudflared, an Apache-2.0 project ([upstream license](https://github.com/cloudflare/cloudflared/blob/master/LICENSE)); include its license when bundling the binary.

## Remaining work before binary distribution

No unresolved registry-license lookup remains in the listed package records. System packages, downloaded tools/models, optional plugins, release binaries, and externally obtained assets need a build-specific inventory. This source review is not a blanket legal certification or a claim that every release artifact has been audited.
