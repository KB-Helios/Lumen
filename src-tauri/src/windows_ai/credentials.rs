use zeroize::Zeroizing;

#[cfg(windows)]
const TARGET: windows::core::PCWSTR = windows::core::w!("com.bridgehammer.lumen.windows-ai.laf");

#[cfg(windows)]
pub fn get() -> Option<Zeroizing<String>> {
    use windows::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
    };
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    if unsafe { CredReadW(TARGET, CRED_TYPE_GENERIC, None, &mut credential) }.is_err()
        || credential.is_null()
    {
        return None;
    }
    let token = unsafe {
        let value = &*credential;
        if value.CredentialBlobSize == 0
            || value.CredentialBlobSize > 2560
            || value.CredentialBlob.is_null()
        {
            None
        } else {
            let bytes = Zeroizing::new(
                std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize)
                    .to_vec(),
            );
            String::from_utf8(bytes.to_vec()).ok().map(Zeroizing::new)
        }
    };
    unsafe {
        CredFree(credential.cast());
    }
    token
}

#[cfg(windows)]
pub fn set(token: Option<String>) -> Result<(), String> {
    use windows::{
        Win32::{
            Foundation::ERROR_NOT_FOUND,
            Security::Credentials::{
                CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredWriteW,
            },
        },
        core::{PWSTR, w},
    };
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return match unsafe { CredDeleteW(TARGET, CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) => {
                Ok(())
            }
            Err(_) => {
                Err("Windows Credential Manager could not remove the access token".to_owned())
            }
        };
    };
    let token = Zeroizing::new(token);
    if token.len() > 2560 || token.trim().is_empty() || token.chars().any(char::is_control) {
        return Err(
            "The Windows AI access token is invalid or exceeds Credential Manager limits"
                .to_owned(),
        );
    }
    let mut bytes = Zeroizing::new(token.as_bytes().to_vec());
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(TARGET.0.cast_mut()),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(w!("Lumen").0.cast_mut()),
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0) }
        .map_err(|_| "Windows Credential Manager could not save the access token".to_owned())
}

#[cfg(not(windows))]
pub fn get() -> Option<Zeroizing<String>> {
    None
}

#[cfg(not(windows))]
pub fn set(_token: Option<String>) -> Result<(), String> {
    Err("Windows Credential Manager is required".to_owned())
}
