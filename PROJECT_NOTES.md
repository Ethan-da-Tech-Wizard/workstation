# Workstation

Two desktop apps that share one workspace: **Workstation** runs on your Linux computer, and **Workstation Guest** runs on your guest’s Windows computer. The guest enters your invitation code inside their app. Files, downloads, and conversation all stay inside the desktop experience.

## Start working together

1. Open **Workstation** from your Linux application menu, or run `./Workstation` in this folder.
2. Click **Add files** or **Add folder** to put files in the shared workspace. You can also drop files or folders onto the app.
3. Click **Invite guest**, then **Save Windows app**. Send that ZIP file to your guest. The ready-to-send file is also at `dist/Workstation-Guest-Windows-x64.zip`.
4. The guest downloads the ZIP, chooses **Extract All**, and opens **Workstation.exe** in the extracted **Workstation Guest** folder. All the files in that folder must stay together.
5. Click **Copy code** in your host app and send that code to your guest. They paste it into **Workstation code**, enter their name, and click **Join workstation**.

The first app to redeem a code gets access. Codes are single-use and expire after 30 minutes if unused. They can be pasted with line breaks or surrounding spaces. A mistyped code fails its checksum. No address is pasted into a browser, and neither app loads a remote webpage.

The first invitation can take a minute while the internet connection becomes ready. The app waits until its connection is reachable before offering the code. Keep your computer online and your host app open while guests use the workspace.

## Files, conversation, and removing people

- Both apps have **Add files**, **Add folder**, drag and drop, and a native **Save a copy** dialog. Folders become ZIP64 archives with their nested folders and empty folders preserved. Windows and Linux can extract them. Symbolic links, special files, and the host’s workspace storage are skipped with a visible notice; each folder can contain up to 100,000 items.
- Transfers show the current file, bytes completed, percentage, speed, and estimated time remaining. Folder scanning shows the number of items found. **Cancel** stops the current transfer, and completed items in a batch remain saved. Errors stay visible in the files panel.
- Shared files live on the Linux host. Guest uploads remain there after the guest leaves or is removed. Downloaded copies belong to the person who saved them.
- **Conversation** is the white chat panel beside the files. Messages are saved on the host.
- Click **Remove** beside a guest’s name to revoke their access and stop their active transfers. Their app returns to the code-entry screen, normally within 1.5 seconds.
- **End session** removes everyone and cancels unused codes. Closing the host app also ends access. Your files and conversation remain saved.
- A guest can click **Leave workspace** and enter a new code later. The host can invite up to 20 guests, using one code per guest.

Guest sessions expire after 24 hours or whenever the host removes them or ends the session. On Windows, the guest app remembers an active session using the operating system’s encrypted storage, so reopening can reconnect without reusing the invitation code. If encrypted storage is unavailable, the app keeps the credential only in memory. The host can remove a guest even when their app is closed.

Guests can upload and save files. Only the host can remove shared files. Removing someone cannot erase copies they already downloaded.

## Your files on disk

The normal Linux launcher uses this folder beside itself:

```text
workspace-data/
  files/             Shared files, with readable filenames
  workspace.json     File records, settings, conversation, recent activity
  .incoming/         Incomplete transfers, discarded on restart
  .trash/            Files removed by the host, kept for recovery
  .desktop/          Host app profile
```

Use **Open files folder** to find saved files. Add files through the app so they appear in its list. Uploading an existing filename creates a separate copy, such as `notes (2).txt`. Editing your original file outside the app does not modify the shared copy; add your revision when ready. To back up everything, close the app and copy `workspace-data`.

Files and folder archives can be up to **1 TB each** (1 TiB). Workspace capacity follows the host drive’s available space, replacing the old 20 GB cap. Imports and downloads check disk space before writing and leave a 256 MB reserve. The shared copy still needs space on the host, and a download needs space on the destination drive. Drives using FAT32 cannot hold files larger than 4 GB; use a filesystem that supports large files, such as NTFS, exFAT, or ext4.

File contents stream through small buffers; a large file is never loaded entirely into memory. Folder archives are written directly to the workspace or uploaded in 8 MB chunks without first creating another ZIP on the source drive. ZIP entries are stored without compression to avoid spending hours recompressing large media or archives.

Guest downloads automatically retry interrupted connections and resume from bytes already written, with a 90-second inactivity timeout rather than a total transfer deadline. After repeated connection failures or a full destination drive, the partial download is retained beside the destination. Choose **Save a copy** again with the same destination to resume, including after restarting the guest app if the session is still valid. **Cancel** discards the partial copy. A SHA-256 integrity check must pass before replacing the destination; failed or canceled transfers preserve an existing destination file. Local saves are verified too. The computer stays awake during active transfers.

Use the updated Windows guest download with the updated host for large files, folder uploads, and resumable downloads. Older guests retain their old size limits.

The Windows guest keeps its settings and encrypted session in `%APPDATA%\Workstation Guest`. Files are saved wherever the guest chooses in the save dialog. There is no silent download or execution of shared files.

## Connection and access

The desktop clients communicate with the host’s application API over TLS through a bundled Cloudflare tunnel. The invitation code contains the routing information and a random secret; the app handles that information internally. You do not need a router change, a forwarded port, or a Cloudflare account.

Files are stored on the host, while network traffic passes through Cloudflare. This transport uses HTTPS, not end-to-end encryption. The guest interface is bundled locally, browser joins are disabled, and the public service exposes only the app protocol and a health response.

Cloudflare’s temporary tunnels have no uptime guarantee. For permanent infrastructure, replace the temporary relay with a managed connection service. See [Cloudflare’s tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Access controls include atomic single-use claims, 256-bit invite/session secrets, per-request authorization, removal that aborts transfers, sanitized filenames, storage quotas, rate limits, blocked browser origins, and host-only IPC actions. The guest renderer never receives session credentials or arbitrary filesystem access. Both windows use isolated, sandboxed renderers and load only packaged local UI files. See [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security/) and [secure storage](https://www.electronjs.org/docs/latest/api/safe-storage).

## Builds and verification

The Windows x64 download includes the official Electron runtime and the guest application. It does not require Node.js, a browser, or the host’s tunnel helper on the guest computer. It is an unsigned portable application, so Windows may display an unknown-publisher warning. Windows OS execution must be checked on Windows; the automated desktop integration runs the same guest application code on Linux.

Development requires Node.js 22.12 or later. The host and client use Node built-ins plus the bundled `yazl` / `buffer-crc32` archive writer. Both desktop packages include these runtime dependencies.

```sh
npm ci
npx install-electron
npm run relay:install
npm run build:windows             # Verified Windows Electron runtime + guest ZIP
npm run build                     # Linux host, including the Windows download
sh scripts/install-user.sh        # Add the host to your application menu

npm test                          # Unit, protocol, persistence and client tests
npm run test:large                # Full >4 GB ZIP64 import/download; needs 10 GB free temporarily
npm run test:desktop              # Two desktop applications and native dialogs
npm run test:desktop -- --packaged # Exercise the packaged application sources
npm run test:desktop -- --internet --packaged # Real internet desktop-to-desktop test
```

`npm run test:browser` remains an alias for the desktop renderer integration tests. Tests use separate temporary profiles, sample files, and test-only local codes. The internet test uses a real relay and shuts it down afterward. Screenshots go to `artifacts`.

`WORKSTATION_DATA_DIR` changes the host storage location, and `WORKSTATION_GUEST_DATA_DIR` changes the guest profile location. Production clients reject test-only `WST-` codes. For source development, start the host with `WORKSTATION_DATA_DIR="$PWD/workspace-data" npx electron .`, or the guest with `npx electron src/guest-main.cjs`. Rebuild both packages after source changes.
