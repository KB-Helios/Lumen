fn main() {
    for path in [
        "../scripts/release.ts",
        "../scripts/sign-release.ps1",
        "../scripts/archive-release.ps1",
        "../scripts/stage-sidecars.ts",
        "../packaging/windows/retained-signers.json",
        "../package.json",
        "Cargo.toml",
        "tauri.conf.json",
        "binaries",
        "resources",
        "../packaging/windows/Assets",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    for key in [
        "LUMEN_RELEASE_BUILD",
        "LUMEN_SIGN_CERT_SHA1",
        "LUMEN_SIGN_CERT_SUBJECT",
        "LUMEN_SIGN_CERT_STORE",
        "LUMEN_SIGNTOOL",
        "RELEASE_TAG",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let binding = match std::env::var("LUMEN_RELEASE_BUILD") {
        Err(std::env::VarError::NotPresent) => "lumen-unsigned-v1".to_owned(),
        Ok(value) if value == "1" => {
            println!("cargo:rerun-if-changed=../.build/release");
            let output = std::process::Command::new("bun")
                .args(["scripts/release.ts", "compile-binding"])
                .current_dir("..")
                .output()
                .expect("Signed release requires Bun and verified staged payloads");
            assert!(
                output.status.success(),
                "Signed release seal/signature validation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let binding = String::from_utf8(output.stdout)
                .expect("Invalid release binding output")
                .trim()
                .to_owned();
            let fields: Vec<_> = binding.split(':').collect();
            assert!(
                fields.len() == 3
                    && fields[0] == "lumen-release-v1"
                    && fields[1..].iter().all(|part| part.len() == 64
                        && part
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())),
                "Invalid verified release binding"
            );
            binding
        }
        _ => panic!("LUMEN_RELEASE_BUILD must be absent or exactly 1"),
    };
    println!("cargo:rustc-env=LUMEN_GATEWAY_BINDING={binding}");
    println!("cargo:rerun-if-changed=../packaging/windows/lumen.manifest");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("../packaging/windows/lumen.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Lumen native build resources could not be generated");
}
