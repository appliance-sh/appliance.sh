fn main() {
    // tauri.conf.json lists apiserver-bin/ as a bundle resource, but
    // the dir is gitignored and only populated by the pnpm pipeline
    // (scripts/stage-apiserver.mjs) — raw `tauri build`/`tauri dev`/IDE
    // cargo builds would fail on the missing path. An empty dir is
    // fine, so make sure it exists on every build path. cwd is the
    // crate root (CARGO_MANIFEST_DIR) for build scripts. Errors are
    // ignored: if creation fails, tauri-build reports the real problem.
    let _ = std::fs::create_dir_all("apiserver-bin");
    tauri_build::build()
}
