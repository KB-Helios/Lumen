fn main() {
    println!("cargo:rerun-if-changed=../packaging/windows/lumen.manifest");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("../packaging/windows/lumen.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Lumen native build resources could not be generated");
}
