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

## IPC surface

Commands exposed by `src-tauri/src/lib.rs`:

| Command                    | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `get_config`               | Returns `{ apiServerUrl, apiKey }` from disk + OS keychain |
| `save_api_server_url(url)` | Writes the cluster URL to `$APP_CONFIG_DIR/config.json`    |
| `save_api_key(id, secret)` | Stores the API key in the OS keychain                      |
| `clear_api_key()`          | Removes the keychain entry (idempotent)                    |

The frontend's `ConsoleHost` calls these via `@tauri-apps/api/core`'s `invoke`.
