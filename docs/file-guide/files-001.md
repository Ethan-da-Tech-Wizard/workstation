# Files 1 of 1 — Workstation

[All pages](../FILE_GUIDE.md) · [Project guide](../PROJECT_GUIDE.md)

| File | Role and useful details |
| --- | --- |
| [.gitignore](../../.gitignore) | Defines local data, credentials, dependencies, and generated outputs that Git should leave untracked. |
| [LICENSE](../../LICENSE) | Preserved license, copyright, or attribution terms; read the full text before reusing the covered component. |
| [PROJECT_NOTES.md](../../PROJECT_NOTES.md) | Preserved detailed setup, usage, architecture, and development notes from the earlier README. |
| [README.md](../../README.md) | Project overview, current status, entry points, setup navigation, and documentation links. |
| [Workstation](../../Workstation) | Command-line automation for Workstation; review prerequisites and side effects before executing. |
| [Workstation.desktop](../../Workstation.desktop) | Linux desktop launcher for Workstation; records the command, icon, and desktop integration settings. |
| [docs/DEPENDENCIES.csv](../../docs/DEPENDENCIES.csv) | Machine-readable inventory of declared and locked dependencies, versions, reported licenses, and evidence URLs. |
| [docs/FILE_GUIDE.md](../../docs/FILE_GUIDE.md) | Index of the complete tracked-file guide, with one entry for every file and links to the paginated descriptions. |
| [docs/LICENSE_REVIEW.md](../../docs/LICENSE_REVIEW.md) | Original-code license, preserved component notices, dependency-license evidence, and unresolved distribution questions. |
| [docs/PROJECT_GUIDE.md](../../docs/PROJECT_GUIDE.md) | Maintainer orientation: purpose, important entry points, source layout, commands, and project-specific boundaries. |
| [docs/file-guide/files-001.md](../../docs/file-guide/files-001.md) | One page of the tracked-file catalog; links each listed path to its role and source-derived details. |
| [package-lock.json](../../package-lock.json) | Dependency lockfile recording resolved package versions and integrity/source metadata; update through the project’s package manager. |
| [package.json](../../package.json) | Node package manifest for workstation-desktop; scripts: start, test, test:large, test:browser, test:desktop, relay:install, build, build:windows; declares package dependencies and metadata. |
| [scripts/download-relay.mjs](../../scripts/download-relay.mjs) | Source module for download relay; defines `hash`. |
| [scripts/install-user.sh](../../scripts/install-user.sh) | Command-line automation for install user; review prerequisites and side effects before executing. |
| [scripts/package-windows.mjs](../../scripts/package-windows.mjs) | Source module for package windows; defines `addDirectory`. |
| [scripts/package.mjs](../../scripts/package.mjs) | Source module for package. |
| [src/desktop-transfers.cjs](../../src/desktop-transfers.cjs) | Source module for desktop transfers; defines `DesktopTransfers`, `onProgress`. |
| [src/file-transfer.cjs](../../src/file-transfer.cjs) | Source module for file transfer; defines `AppError`, `cleanName`, `progressReporter`, `checkDiskSpace`, `prepareSource`, `copyVerified`, `stop`. |
| [src/guest-client.cjs](../../src/guest-client.cjs) | Source module for guest client; defines `GuestClient`, `retryable`, `touch`. |
| [src/guest-main.cjs](../../src/guest-main.cjs) | Source module for guest main; defines `secureStorageAvailable`. |
| [src/guest-server.cjs](../../src/guest-server.cjs) | Source module for guest server; defines `json`, `body`, `readJSON`, `startGuestServer`, `rate`, `untrack`. |
| [src/invite-code.cjs](../../src/invite-code.cjs) | Source module for invite code; defines `codeError`, `checksum`, `validOrigin`, `encodeInviteCode`, `decodeInviteCode`. |
| [src/main.cjs](../../src/main.cjs) | Source module for main. |
| [src/preload.cjs](../../src/preload.cjs) | Source module for preload; defines `listener`. |
| [src/tunnel.cjs](../../src/tunnel.cjs) | Source module for tunnel; defines `Tunnel`, `finish`, `checkPublicAddress`, `handle`. |
| [src/workspace.cjs](../../src/workspace.cjs) | Source module for workspace; defines `Workspace`, `digest`. |
| [tests/browser.mjs](../../tests/browser.mjs) | Test implementation for browser. |
| [tests/desktop.mjs](../../tests/desktop.mjs) | Test implementation for desktop; defines `openApp`, `createCode`, `join`, `pickFile`, `saveCopy`. |
| [tests/guest-client.test.cjs](../../tests/guest-client.test.cjs) | Test implementation for guest client.test. |
| [tests/large-transfer.cjs](../../tests/large-transfer.cjs) | Test implementation for large transfer; defines `progress`. |
| [tests/transfers.test.cjs](../../tests/transfers.test.cjs) | Test implementation for transfers.test; defines `setup`, `disconnectProxy`. |
| [tests/workspace.test.cjs](../../tests/workspace.test.cjs) | Test implementation for workspace.test; defines `setup`, `invite`, `addFile`, `serverSetup`, `request`, `claim`, `tokenFor`. |
| [ui/app.js](../../ui/app.js) | Source module for app; defines `icon`, `el`, `actionButton`, `initials`, `avatar`, `bytes`, `shortDate` and 25 more symbols. |
| [ui/icon.png](../../ui/icon.png) | Image or interface asset for icon; 256 × 256 pixels. Source/asset rights remain separate from software-license terms. |
| [ui/icon.svg](../../ui/icon.svg) | Image or interface asset for icon. Source/asset rights remain separate from software-license terms. |
| [ui/index.html](../../ui/index.html) | Browser document: Workstation; provides page structure and may include inline styles or application logic. |
| [ui/styles.css](../../ui/styles.css) | Presentation rules for styles; controls layout, typography, color, states, and responsive behavior. |
