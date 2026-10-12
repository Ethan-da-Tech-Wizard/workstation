# Workstation

A host-and-guest desktop workspace for sharing files, exchanging messages, and issuing single-use invitation codes.

**Status:** Desktop collaboration prototype  
**Built with:** Electron, Node.js, JavaScript

[Project guide](docs/PROJECT_GUIDE.md) · [Every file explained](docs/FILE_GUIDE.md) · [Licenses and dependencies](docs/LICENSE_REVIEW.md)

## Start here

- [PROJECT_NOTES.md](PROJECT_NOTES.md) — Preserved detailed setup, usage, architecture, and development notes from the earlier README.
- [src/main.cjs](src/main.cjs) — Source module for main.
- [src/guest-main.cjs](src/guest-main.cjs) — Source module for guest main; defines `secureStorageAvailable`.
- [package.json](package.json) — Node package manifest for workstation-desktop; scripts: start, test, test:large, test:browser, test:desktop, relay:install, build, build:windows; declares package dependencies and metadata.

The following commands are taken from this project’s source/configuration. Install its prerequisites first.

```sh
npm ci
npm start
# Unit tests:
npm test
```

[Detailed setup, usage, and development notes](PROJECT_NOTES.md) preserve the previous project documentation.

## Repository layout

| Path | Role |
| --- | --- |
| [docs/](docs/) | Project documentation, decisions, and reference material (5 tracked entries). |
| [scripts/](scripts/) | Build, launch, maintenance, and verification commands (4 tracked entries). |
| [src/](src/) | Application source and platform integration (10 tracked entries). |
| [tests/](tests/) | Automated checks and test fixtures (6 tracked entries). |
| [ui/](ui/) | User-facing interface code and resources (5 tracked entries). |

## Scope and current limits

Original code is MIT licensed. Electron, archive libraries, and the separately downloaded relay have their own terms.

## License

Original project code retains **MIT** terms in [LICENSE](LICENSE). Third-party libraries, media, data, models, and tools retain their own terms. See the [license review](docs/LICENSE_REVIEW.md) and [dependency inventory](docs/DEPENDENCIES.csv).
