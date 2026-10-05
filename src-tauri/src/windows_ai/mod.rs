#[cfg(test)]
mod tests {
    #[test]
    fn local_answers_require_windows_opt_in_and_preview_tools_keep_separate_consent() {
        let preferences = super::preferences::Preferences::default();
        assert!(preferences.gate("answer").is_err());
        let enabled = preferences
            .patch(serde_json::json!({"windowsEnabled":true}))
            .unwrap();
        assert!(enabled.gate("answer").is_ok());
        assert!(enabled.gate("text").is_err());
        assert!(enabled.feature_enabled("languageModel"));
        assert!(!enabled.feature_enabled("summarize"));
    }

    #[test]
    fn a_later_identical_activation_is_a_new_user_draft() {
        let mut queue = super::activation::ActivationQueue::default();
        let uri = "lumen:agent?agentName=lumen.browser&prompt=repeatable";
        assert!(queue.enqueue(uri).unwrap().is_some());
        queue.consume().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2100));
        assert!(queue.enqueue(uri).unwrap().is_some());
    }

    #[test]
    fn rejects_untrusted_activation_and_consumes_valid_drafts_once() {
        assert!(super::activation::parse_activation("https://example.test/agent").is_err());
        assert!(
            super::activation::parse_activation("lumen:agent?agentName=other&prompt=hello")
                .is_err()
        );
        let mut queue = super::activation::ActivationQueue::default();
        let uri = "lumen:agent?agentName=lumen.browser&prompt=hello%20world";
        assert!(queue.enqueue(uri).unwrap().is_some());
        assert!(queue.enqueue(uri).unwrap().is_none());
        assert_eq!(queue.consume().unwrap().prompt, "hello world");
        assert!(queue.consume().is_none());
    }

    #[test]
    fn activation_rejects_oversize_duplicate_and_malformed_parameters() {
        for uri in [
            "lumen://agent?agentName=lumen.browser&prompt=hello",
            "lumen:agent?agentName=lumen.browser&prompt=hello&prompt=other",
            "lumen:agent?agentName=lumen.browser&prompt=%FF",
            "lumen:agent?agentName=lumen.browser&prompt=%XX",
            "lumen:agent?agentName=lumen.browser&prompt=hello&url=https%3A%2F%2Fevil.test",
        ] {
            assert!(super::activation::parse_activation(uri).is_err(), "{uri}");
        }
        let oversized = format!(
            "lumen:agent?agentName=lumen.browser&prompt={}",
            "a".repeat(4001)
        );
        assert!(super::activation::parse_activation(&oversized).is_err());
    }

    #[test]
    fn all_privileged_preferences_default_to_opt_out_and_revoke_at_dispatch() {
        let preferences = super::preferences::Preferences::default();
        assert!(!preferences.windows_enabled);
        assert!(!preferences.model_downloads_allowed);
        assert!(!preferences.agents_enabled);
        assert!(!preferences.register_lumen_agent);
        assert!(!preferences.text_tools_enabled);
        assert!(!preferences.ocr_enabled);
        assert!(!preferences.app_content_enabled);
        assert!(preferences.gate("text").is_err());
        let enabled = preferences
            .patch(serde_json::json!({"windowsEnabled":true,"textToolsEnabled":true}))
            .unwrap();
        assert!(enabled.gate("text").is_ok());
        let revoked = enabled
            .patch(serde_json::json!({"textToolsEnabled":false}))
            .unwrap();
        assert!(revoked.gate("text").is_err());
        assert!(enabled.gate("prepare").is_err());
    }

    #[test]
    fn preferences_reject_unknown_fields_and_invalid_language_or_engine() {
        let preferences = super::preferences::Preferences::default();
        for patch in [
            serde_json::json!({"accessToken":"secret"}),
            serde_json::json!({"localEngine":"external-process"}),
            serde_json::json!({"speechLanguage":"../../unsafe"}),
            serde_json::json!({"sourceLanguage":"a"}),
            serde_json::json!({"windowsEnabled":"true"}),
        ] {
            assert!(preferences.patch(patch).is_err());
        }
    }

    #[test]
    fn bounded_protocol_rejects_foreign_ids_and_invalid_progress() {
        for id in ["", "bad id", "../unsafe", "\n"] {
            assert!(super::protocol::validate_request_id(id).is_err());
        }
        assert!(super::protocol::validate_request_id("request-1:ocr").is_ok());
        assert!(
            super::protocol::parse_envelope(
                br#"{"id":"other","type":"result","data":{}}"#,
                "request"
            )
            .is_err()
        );
        assert!(
            super::protocol::parse_envelope(
                br#"{"id":"request","type":"progress","phase":"download","progress":2}"#,
                "request"
            )
            .is_err()
        );
        let oversized = vec![b'a'; 1024 * 1024 + 1];
        assert!(super::protocol::read_bounded_line(&mut std::io::Cursor::new(oversized)).is_err());
    }

    #[test]
    fn public_catalogue_resolution_rejects_unknown_destinations_and_ids() {
        let catalogue = super::catalogue::Catalogue::embedded().unwrap();
        assert!(
            !catalogue
                .resolve(&["lumen.privacy".to_owned()])
                .unwrap()
                .is_empty()
        );
        assert!(catalogue.resolve(&["private.file".to_owned()]).is_err());
        assert!(super::catalogue::Catalogue::parse(r#"{"version":1,"items":[{"id":"evil","title":"Evil","description":"x","settingsPage":"../../private","keywords":[]}]}"#).is_err());
    }

    #[test]
    fn confined_reads_reject_outside_paths_and_oversize_images() {
        let fixture = crate::search::test_support::SearchFixture::new("windows-ai-reads");
        let outside = fixture.outside_file("private.png", b"secret");
        assert!(super::files::confined_read(fixture.root(), &outside, 4 * 1024 * 1024).is_err());
        let large = fixture.file("large.png", &vec![0; 4 * 1024 * 1024 + 1]);
        assert!(super::files::confined_read(fixture.root(), &large, 4 * 1024 * 1024).is_err());
        let small = fixture.file("small.png", b"pixels");
        assert_eq!(
            super::files::confined_read(fixture.root(), &small, 4 * 1024 * 1024).unwrap(),
            b"pixels"
        );
    }
}
mod activation;
mod catalogue;
mod commands;
mod credentials;
mod files;
mod preferences;
mod protocol;
mod supervisor;
mod types;

pub use commands::*;
pub use supervisor::WindowsAiRuntime;

pub fn queue_activations(app: &tauri::AppHandle, args: &[String]) {
    use tauri::{Emitter, Manager};
    let Some(runtime) = app.try_state::<std::sync::Arc<WindowsAiRuntime>>() else {
        return;
    };
    for uri in args
        .iter()
        .filter(|argument| argument.starts_with("lumen:"))
    {
        let activation = runtime
            .activations
            .lock()
            .ok()
            .and_then(|mut queue| queue.enqueue(uri).ok().flatten());
        if let Some(activation) = activation {
            // Wake the UI to consume a draft after hydration. This path never
            // touches the cloud worker or calls a Computer Use start command.
            let _ = app.emit(
                "lumen://windows-agent-activation",
                serde_json::json!({"activationId":activation.activation_id}),
            );
            let _ = crate::window::show_from_app(
                app,
                crate::window::WindowMode::Collapsed,
                crate::window::WindowStateSource::SecondInstance,
            );
        }
    }
}
