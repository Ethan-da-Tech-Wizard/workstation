# Workstation

A host-and-guest desktop workspace for sharing files, exchanging messages, and issuing single-use invitation codes.

**Status:** Desktop collaboration prototype  
**Built with:** Electron, Node.js, JavaScript

## Reading order

1. Read the root README for project purpose and setup navigation.
2. Follow the entry points below to find the implementation.
3. Use the file guide to locate individual modules, tests, assets, and configuration.
4. Check component licenses before redistributing dependencies or assets.

## Important paths

- [PROJECT_NOTES.md](../PROJECT_NOTES.md) — Preserved detailed setup, usage, architecture, and development notes from the earlier README.
- [src/main.cjs](../src/main.cjs) — Source module for main.
- [src/guest-main.cjs](../src/guest-main.cjs) — Source module for guest main; defines `secureStorageAvailable`.
- [package.json](../package.json) — Node package manifest for workstation-desktop; scripts: start, test, test:large, test:browser, test:desktop, relay:install, build, build:windows; declares package dependencies and metadata.

## Structure

| Path | Role |
| --- | --- |
| [docs/](../docs/) | Project documentation, decisions, and reference material (5 tracked entries). |
| [scripts/](../scripts/) | Build, launch, maintenance, and verification commands (4 tracked entries). |
| [src/](../src/) | Application source and platform integration (10 tracked entries). |
| [tests/](../tests/) | Automated checks and test fixtures (6 tracked entries). |
| [ui/](../ui/) | User-facing interface code and resources (5 tracked entries). |

## Useful commands

Run from the repository root after following the documented prerequisites.

```sh
npm ci
npm start
# Unit tests:
npm test
```

## Scope

Original code is MIT licensed. Electron, archive libraries, and the separately downloaded relay have their own terms.

## Maintaining the guide

The file catalog is a source-inspection snapshot, not proof that every runtime path works. Update it when moving files or changing module responsibilities. The 2026-10-12 documentation review did not run every application, deploy services, or validate all historical performance claims.
