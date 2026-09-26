# Build and publish Arsenal

## Build locally

Use the Node version in `.nvmrc`. To export the model on Linux x64, install Python 3.12, then run:

```sh
npm ci
npm run prepare:laya
npm run make
```

Find the distributables in `dist`. Forge compiles the production Webpack bundles and creates an intermediate app in `out`. Electron Builder packages those bundles, signs the release app, and generates the update metadata.

`prepare:laya` downloads the pinned Laya checkpoint and exporter, installs an isolated Python environment under `.cache/laya`, and exports the model to `assets/laya`. The export checks its ONNX output against the original model before packaging. It also prepares the native Node inference runtime in `assets/laya-runtime`. Set `LAYA_PYTHON` to your Python 3.12 executable if it is not your default Python.

Allow several gigabytes of free disk space for preparation. The exported model occupies about 1.6 GiB. Both generated directories are ignored by Git. The app bundles them outside its ASAR archive and runs offline without Python. Packaging fails if a present model or the required native runtime is incomplete.

You can run `npm start` or `npm run make` without `assets/laya`. The app then offers a model download before generating recommendations. Downloads use the `laya-*` assets attached to the GitHub release that matches the app version, check every file's size and SHA-256, and keep the model in the app's user data directory. A download requires that matching release to be published. Development builds without a matching published model must use `npm run prepare:laya`.

The checkpoint revision, exporter revision, license, and file checksums are recorded in `assets/laya/manifest.json`. Model preparation and verification copy that manifest into `src/shared/laya-model-manifest.json`, which the app embeds for downloads even when the model is absent. Keep this file when building without `assets/laya`. ONNX graphs contain exporter paths, so each export can have different checksums. The release workflow embeds the same verified manifest in every app and uploads its matching files. The model directory includes the Apache 2.0 license and the original model card. The source revisions and Python dependency versions are pinned in `scripts/prepare-laya.py` and `scripts/prepare-laya.requirements.txt`.

Build on the target operating system and architecture. The workflow exports and verifies the model once on Ubuntu x64, then shares that artifact with all six native Windows, macOS, and Linux builds. Each build prepares its own native inference runtime. To reuse an export locally, copy the complete `assets/laya` directory and run `npm run prepare:laya` on the target machine. A valid existing export skips Python and model downloads.

On Intel Macs, reuse the `laya-model` workflow artifact or copy an export from Linux. The pinned PyTorch exporter has no Intel macOS wheel. Extract the complete artifact into `assets/laya` before running `npm run prepare:laya`. Python is not required when you reuse an export.

| Platform | Install this build |
| --- | --- |
| Windows | Run the `.exe` installer. |
| macOS | Open the `.dmg` and move Arsenal to Applications. |
| Linux | Make the `.AppImage` executable and run it from a writable folder. |

The macOS `.zip` files are also required for automatic updates. Keep them with the release assets.

## Configure macOS signing

Add these repository secrets under **Settings > Secrets and variables > Actions** before publishing a version tag:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application certificate exported as a `.p12`, including its private key. |
| `MAC_CSC_KEY_PASSWORD` | Password for the `.p12` file. |
| `APPLE_ID` | Apple Developer account email. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization. |
| `APPLE_TEAM_ID` | Apple Developer team ID. |

Use a Developer ID Application certificate for distribution outside the Mac App Store. Follow the [Electron Builder signing guide](https://www.electron.build/v26/docs/features/code-signing/) to export the certificate and configure notarization.

For signed local builds, set `CSC_LINK` and `CSC_KEY_PASSWORD` along with the three Apple variables above before running `npm run make`. You can use `CSC_NAME` instead of `CSC_LINK` when the certificate is already in your keychain.

Pull requests, pushes to `main`, and manual workflow runs produce build artifacts without signing credentials. macOS builds use ad-hoc signing for these previews. Use a signed release build to test automatic updates on macOS. Windows builds use unsigned per-user NSIS installers.

## Publish a version

1. Bump the stable version in `package.json` and `package-lock.json` with `npm version patch --no-git-tag-version`. Use `minor` or `major` when appropriate.
2. Commit the version change and push it to `main`.
3. Create and push a matching tag, such as `v1.0.1` for package version `1.0.1`.
4. Wait for **Build executables** to finish all six builds.

The workflow uploads the installers, archives, blockmaps, update manifests, and `laya-*` model files to a draft GitHub release, then publishes it. It uploads one copy of the model for all platforms. It uses the workflow's `GITHUB_TOKEN`. No personal access token is needed.

If an upload fails, rerun the failed jobs to finish the draft. To change an already published build, bump the version and publish a new tag. The workflow refuses to overwrite published versions.

Keep every `latest-*.yml` file and `.blockmap` file with its matching build. Each architecture uses a separate update channel to prevent parallel builds from overwriting each other's metadata. The app reads its channel from `app-update.yml`, which Electron Builder embeds in the app.

## Verify an update

1. Install a signed macOS release, a Windows installer, or a Linux AppImage from GitHub Releases.
2. Publish a higher stable version using the steps above.
3. In Arsenal's sidebar, click **Check for updates**.
4. Click **Download update** and wait for the download to finish.
5. Click **Install and restart**. Confirm that Arsenal reopens with the new version.

Arsenal also checks ten seconds after startup and every six hours while it stays open. Downloads require a click. A downloaded update waits for **Install and restart**, and that button is disabled while a library action is running. Development sessions do not check for updates.

Use a writable AppImage file on Linux. On macOS, test from Applications using Developer ID signed builds. See [Electron Builder's updater documentation](https://www.electron.build/v26/docs/features/auto-update/) for platform requirements.
