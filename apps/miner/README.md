# EticaHub Miner

One-click desktop miner for the EticaHub pools. Paste a wallet, press Mine:

- **ETI** on the CPU: RandomX via a pinned [XMRig](https://github.com/xmrig/xmrig) release against `etipool.eticahub.com` (port picked by thread count).
- **EGAZ** on the GPU: etchash via a pinned [lolMiner](https://github.com/Lolliedieb/lolMiner-releases) release against `pool.eticahub.com:8008` (Windows/Linux, NVIDIA or AMD).

Both pools charge 0.5% and pay out automatically to the wallet entered. Engines are downloaded on first run into the app data
folder, SHA-256 checked against the pinned release, and killed when the app closes. Hashrate and shares come from the engines'
local HTTP APIs; unpaid/paid balances come from the pool APIs.

## Develop

```sh
pnpm install --filter @etica-hub/miner
pnpm --filter @etica-hub/miner tauri dev
```

Needs Rust stable and, on Linux, `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.

## Release

Tag `miner-vX.Y.Z` (or run the "Miner release" workflow by hand). `.github/workflows/miner-release.yml` builds Windows (.msi,
setup .exe), macOS (.dmg, arm + intel) and Linux (.AppImage, .deb) and attaches them to a GitHub Release of the same name.
Builds are unsigned; SmartScreen/Gatekeeper prompt once on first launch.

To bump an engine: change the version constant and the matching SHA-256 sums in `src-tauri/src/engines.rs`
(XMRig publishes `SHA256SUMS`; lolMiner does not, compute them from the downloaded archives).
