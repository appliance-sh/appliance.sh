# @appliance.sh/desktop

Tauri 2 shell for the Appliance desktop app. Frontend is `@appliance.sh/app`; the shell adds OS keychain storage, external URL opening, and native notifications via Rust commands.

## Prerequisites

- Node.js 22+ and `pnpm`
- Rust toolchain (`rustup` + stable `cargo`)
- Platform build deps per https://v2.tauri.app/start/prerequisites/

## Icons

Placeholder PNGs are checked in under `src-tauri/icons/` so `cargo check` and `tauri dev` work out of the box. Before shipping an installer, replace them with real icons:

```
pnpm tauri icon path/to/source.png
```

Source image should be at least 1024×1024 PNG with transparency. That command regenerates the PNGs and adds `.icns` / `.ico` too. Re-add `icons/icon.icns` and `icons/icon.ico` to `src-tauri/tauri.conf.json`'s `bundle.icon` array before running `pnpm tauri build` on macOS / Windows.

## Scripts

```
pnpm dev            # Vite frontend dev server (1420)
pnpm build          # Vite frontend build → dist/
pnpm tauri dev      # Launch the Tauri window (runs `pnpm dev` first)
pnpm tauri build    # Build installers for the current platform
```

## macOS: stable code-signing for local dev

The app reads each cluster's API key from the macOS Keychain, and macOS gates
Keychain access on the app's code-signing identity. A plain `pnpm tauri build`
**ad-hoc**-signs the bundle with the raw binary hash, which changes on every
rebuild — so each new dev build looks like a different app to the Keychain and
re-prompts for your password. At startup that prompt blocks the WKWebView from
painting (blank window) and starves the API key (every screen shows
"Load failed").

Fix: sign every dev build with one **stable** self-signed certificate.

1. Create a code-signing cert named `Appliance Dev`:
   Keychain Access → Certificate Assistant → _Create a Certificate…_ →
   Name `Appliance Dev`, Identity Type **Self Signed Root**, Certificate Type
   **Code Signing** → Create.
2. Let `codesign` use the key without prompting (one time; enter your login
   password at the prompt):
   ```
   security set-key-partition-list -S apple-tool:,apple: -s -l "Appliance Dev" ~/Library/Keychains/login.keychain-db
   ```
3. Build normally. `pnpm tauri:build` runs `scripts/sign-macos.mjs`, which
   re-signs the bundled `.app` with the cert. Launch it once, click
   **Always Allow** on the Keychain prompt — and because the signing requirement
   is keyed to the cert (not the binary), you won't be prompted on future
   rebuilds.

Override the cert name with `APPLIANCE_MACOS_SIGN_IDENTITY`. Without the cert
present the signing step is a no-op, so CI and other contributors are
unaffected. The cleartext microVM API (`http://api.appliance.localhost`) also
needs the App Transport Security exception already declared in
`src-tauri/Info.plist`.

## IPC surface

Commands exposed by `src-tauri/src/lib.rs`:

| Command                    | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `get_config`               | Returns `{ apiServerUrl, apiKey }` from disk + OS keychain |
| `save_api_server_url(url)` | Writes the cluster URL to `$APP_CONFIG_DIR/config.json`    |
| `save_api_key(id, secret)` | Stores the API key in the OS keychain                      |
| `clear_api_key()`          | Removes the keychain entry (idempotent)                    |

The frontend's `ConsoleHost` calls these via `@tauri-apps/api/core`'s `invoke`.
