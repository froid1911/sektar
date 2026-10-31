// GENERATED — mirrors the reference shell. Connect is served over
// http://127.0.0.1 (a remote origin to Tauri), so the launch-queue commands
// need an explicit ACL; declaring the command manifest here generates the
// allow-<command> permissions that capabilities/*.json grant.
fn main() {
    // The icon set is a COMPILE-TIME input (the Windows resource icon here,
    // and the tray/window icon tauri::generate_context! embeds), but
    // tauri-build registers no rerun trigger for it: without this line a
    // regenerated icon set leaves the old icon compiled into the binary.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "take_launch_files",
            "read_launch_file",
            "log_from_webview",
            "open_external",
            "desktop_state",
            "pick_root",
            "save_renown_url",
            "local_create",
            "local_unlock",
            "saved_credential",
            "save_profile",
            "adopt_old_data",
            "start_stack",
            "switch_identity",
        ]),
    ))
    .expect("failed to run tauri-build");
}
