use std::{fs, path::PathBuf};

#[derive(Clone)]
pub struct PersistedConsent {
    settings_path: PathBuf,
}

impl PersistedConsent {
    pub fn new(settings_path: PathBuf) -> Self {
        Self { settings_path }
    }

    fn setting(&self, section: &str, key: &str) -> bool {
        fs::read_to_string(&self.settings_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
            .and_then(|settings| {
                settings
                    .get("management")?
                    .get(section)?
                    .get(key)?
                    .as_bool()
            })
            .unwrap_or(false)
    }

    pub fn answer_granted(&self) -> bool {
        self.setting("ai", "cloudAnswerConsent")
    }

    pub fn computer_use_granted(&self) -> bool {
        self.setting("computerUse", "cloudConsent")
    }

    pub fn desktop_control_granted(&self) -> bool {
        self.setting("computerUse", "desktopControlConsent")
    }

    pub fn desktop_cloud_granted(&self) -> bool {
        self.setting("computerUse", "desktopCloudConsent")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_fails_closed_and_reads_only_persisted_boolean_values() {
        let directory =
            std::env::temp_dir().join(format!("lumen-consent-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("lumen.settings.json");
        let consent = PersistedConsent::new(path.clone());

        assert!(!consent.answer_granted());
        assert!(!consent.computer_use_granted());

        fs::write(
            &path,
            r#"{"management":{"ai":{"cloudAnswerConsent":true},"computerUse":{"cloudConsent":true}}}"#,
        )
        .unwrap();
        assert!(consent.answer_granted());
        assert!(consent.computer_use_granted());
        assert!(!consent.desktop_control_granted());
        assert!(!consent.desktop_cloud_granted());

        fs::write(&path, r#"{"management":{"computerUse":{"desktopControlConsent":true,"desktopCloudConsent":true}}}"#).unwrap();
        assert!(consent.desktop_control_granted());
        assert!(consent.desktop_cloud_granted());
        assert!(!consent.computer_use_granted());

        fs::write(
            &path,
            r#"{"management":{"ai":{"cloudAnswerConsent":"true"}}}"#,
        )
        .unwrap();
        assert!(!consent.answer_granted());
        assert!(!consent.computer_use_granted());

        fs::remove_dir_all(directory).unwrap();
    }
}
