//! Private native ownership snapshots share the live writer's crash-recoverable transaction.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Ownership {
    Exclusive {
        floor_hash: String,
    },
    Additive {
        before: Option<Value>,
        applied: Value,
    },
}

fn snapshot_path(home: &Path, app: &str, id: &str) -> PathBuf {
    let id_hash = digest(Some(id.as_bytes())).expect("present id has a hash");
    paths::device_dir(home)
        .join("profile-ownership")
        .join(format!("{app}-{id_hash}.json"))
}

fn snapshot(
    home: &Path,
    app: &str,
    id: &str,
) -> Result<(Option<Vec<u8>>, Option<Ownership>), String> {
    let bytes = read_bytes(&snapshot_path(home, app, id))?;
    let owner = bytes
        .as_deref()
        .map(|bytes| {
            serde_json::from_slice(bytes)
                .map_err(|_| "Provider ownership snapshot is invalid".to_string())
        })
        .transpose()?;
    Ok((bytes, owner))
}

pub(super) fn has_snapshot(home: &Path, app: &str, id: &str) -> Result<bool, String> {
    Ok(snapshot(home, app, id)?.1.is_some())
}

fn live_path(home: &Path, app: &str) -> Result<PathBuf, String> {
    let path = match app {
        "claude" => paths::claude_settings(home),
        "codex" => paths::codex_config(home),
        "gemini" => paths::gemini_env(home),
        "opencode" => paths::opencode_config(home),
        "openclaw" => paths::openclaw_config(home),
        _ => {
            return Err(
                "unknown app; expected claude, codex, gemini, opencode, or openclaw".into(),
            );
        }
    };
    ensure_within_home(home, &path)?;
    Ok(path)
}

fn exclusive_bytes(
    app: &str,
    bytes: Option<&[u8]>,
    path: &Path,
    target: Option<&ProviderTarget>,
) -> Result<Option<Vec<u8>>, String> {
    match app {
        "claude" => apply_claude_bytes(bytes, path, target),
        "codex" => apply_codex_toml(bytes, path, target),
        "gemini" => apply_gemini_env(bytes, path, target),
        _ => Err("Unsupported exclusive target".into()),
    }
}

// Hash only the writer's floor so unrelated user edits do not revoke ownership.
fn floor_hash(app: &str, path: &Path, bytes: &[u8]) -> Result<String, String> {
    let floor = if app == "claude" {
        let mut value = parse_json_object(path, bytes)?;
        let root = value
            .as_object_mut()
            .ok_or("Provider settings must be an object")?;
        root.retain(|key, _| key == "env" || claude_floor_top(key));
        if let Some(env) = root.get_mut("env").and_then(Value::as_object_mut) {
            env.retain(|key, _| claude_floor_env(key));
        }
        pretty(&value)?
    } else {
        let text = std::str::from_utf8(bytes).map_err(|_| "Provider settings must be UTF-8")?;
        let mut section = Vec::new();
        let rows: Vec<&str> = text
            .lines()
            .filter(|line| {
                if app == "gemini" {
                    return dotenv_key(line).is_some_and(gemini_floor_env);
                }
                if let Some(header) = parse_table_header(line) {
                    section = header;
                    return false;
                }
                if section
                    .iter()
                    .map(String::as_str)
                    .eq(CODEX_PROVIDER_TABLE.iter().copied())
                {
                    return !line.trim().is_empty();
                }
                toml_key(line).is_some_and(|key| {
                    (section.is_empty() && CODEX_FLOOR_TOP.contains(&key.as_str()))
                        || is_codex_nested_floor(&section, &key)
                })
            })
            .collect();
        rows.join("\n").into_bytes()
    };
    Ok(digest(Some(&floor)).expect("present floor has a hash"))
}

pub(super) fn is_owned(
    home: &Path,
    app: &str,
    id: &str,
    path: &Path,
    bytes: &[u8],
) -> Result<bool, String> {
    match snapshot(home, app, id)?.1 {
        Some(Ownership::Additive { .. }) if matches!(app, "opencode" | "openclaw") => Ok(true),
        Some(Ownership::Exclusive {
            floor_hash: expected,
        }) if matches!(app, "claude" | "codex" | "gemini") => {
            Ok(floor_hash(app, path, bytes)? == expected)
        }
        None => Ok(false),
        _ => Err("Provider ownership snapshot does not match its tool".into()),
    }
}

fn providers<'a>(value: &'a mut Value, app: &str) -> Result<&'a mut Map<String, Value>, String> {
    let root = value
        .as_object_mut()
        .ok_or("Provider settings must be an object")?;
    let container = if app == "opencode" {
        root
    } else {
        root.entry("models")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("Provider models must be an object")?
    };
    container
        .entry(if app == "opencode" {
            "provider"
        } else {
            "providers"
        })
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Providers must be an object".into())
}

/// Undo only unchanged managed leaves; later user additions/edits take precedence.
fn restore(current: &Value, applied: &Value, before: Option<&Value>) -> Option<Value> {
    if current == applied {
        return before.cloned();
    }
    if let (Some(current), Some(applied)) = (current.as_object(), applied.as_object()) {
        let mut result = current.clone();
        for (key, managed) in applied {
            if let Some(live) = result.get(key) {
                match restore(live, managed, before.and_then(|value| value.get(key))) {
                    Some(value) => {
                        result.insert(key.clone(), value);
                    }
                    None => {
                        result.remove(key);
                    }
                }
            }
        }
        return if result.is_empty() && before.is_none() {
            None
        } else {
            Some(Value::Object(result))
        };
    }
    if let (Some(current), Some(applied)) = (current.as_array(), applied.as_array()) {
        let mut result = current.clone();
        for managed in applied {
            if let Some(index) = result
                .iter()
                .position(|model| model.get("id") == managed.get("id"))
            {
                let prior = before.and_then(Value::as_array).and_then(|models| {
                    models
                        .iter()
                        .find(|model| model.get("id") == managed.get("id"))
                });
                match restore(&result[index], managed, prior) {
                    Some(mut value) => {
                        // A user-enriched model still needs its identity after owned leaves are removed.
                        if let Some(object) = value.as_object_mut() {
                            for key in ["id", "name"] {
                                if let Some(identity) = result[index].get(key) {
                                    object.entry(key).or_insert_with(|| identity.clone());
                                }
                            }
                        }
                        result[index] = value;
                    }
                    None => {
                        result.remove(index);
                    }
                }
            }
        }
        return if result.is_empty() && before.is_none() {
            None
        } else {
            Some(Value::Array(result))
        };
    }
    Some(current.clone())
}

fn publish_profile(
    home: &Path,
    app: &str,
    id: &str,
    live: Planned,
    owner_before: Option<Vec<u8>>,
    owner: Option<Ownership>,
    target: Option<String>,
) -> Result<Vec<PathBuf>, String> {
    let owner_path = snapshot_path(home, app, id);
    ensure_within_home(home, &owner_path)?;
    let owner_bytes = owner
        .map(|owner| {
            serde_json::to_vec(&owner)
                .map_err(|_| "Provider ownership could not be saved".to_string())
        })
        .transpose()?;
    for bytes in [&live.bytes, &owner_bytes].into_iter().flatten() {
        if bytes.len() > MAX_TEXT_BYTES {
            return Err("Provider configuration limit reached".into());
        }
    }
    let path = live.file.path.clone();
    let plans = [
        live,
        plan_from(&LiveFile::private(owner_path), owner_before, owner_bytes),
    ];
    let changed = run_operation(&DeviceStore::for_home(home), app, "profile", &plans, target)?;
    Ok(changed
        .into_iter()
        .filter(|changed| changed == &path)
        .collect())
}

pub(super) fn activate(
    home: &Path,
    app: &str,
    target: &ProviderTarget,
) -> Result<Vec<PathBuf>, String> {
    validate_provider_id(&target.id)?;
    let path = live_path(home, app)?;
    let pre = read_bytes(&path)?;
    let (owner_before, old_owner) = snapshot(home, app, &target.id)?;
    let (after, owner) = if matches!(app, "opencode" | "openclaw") {
        let mut value = pre
            .as_ref()
            .map(|bytes| parse_json_object(&path, bytes))
            .transpose()?
            .unwrap_or_else(|| {
                if app == "opencode" {
                    serde_json::json!({"$schema":"https://opencode.ai/config.json"})
                } else {
                    serde_json::json!({"models":{"mode":"merge","providers":{}}})
                }
            });
        let nodes = providers(&mut value, app)?;
        let mut before = nodes.get(&target.id).cloned();
        if let Some(Ownership::Additive {
            before: prior,
            applied,
        }) = old_owner
        {
            before = before
                .as_ref()
                .and_then(|live| restore(live, &applied, prior.as_ref()));
        }
        let applied = if app == "opencode" {
            opencode_node(target)
        } else {
            openclaw_node(target)
        };
        let mut node = before.clone().unwrap_or_else(|| serde_json::json!({}));
        merge_profile_fields(&mut node, applied.clone());
        nodes.insert(target.id.clone(), node);
        (
            Some(pretty(&value)?),
            Ownership::Additive { before, applied },
        )
    } else {
        let after = exclusive_bytes(app, pre.as_deref(), &path, Some(target))?;
        let hash = floor_hash(
            app,
            &path,
            after
                .as_deref()
                .ok_or("Provider configuration is missing")?,
        )?;
        (after, Ownership::Exclusive { floor_hash: hash })
    };
    publish_profile(
        home,
        app,
        &target.id,
        plan_from(&LiveFile::private(path), pre, after),
        owner_before,
        Some(owner),
        if matches!(app, "opencode" | "openclaw") {
            None
        } else {
            Some(target.id.clone())
        },
    )
}

pub(super) fn remove(home: &Path, app: &str, target: &ProviderTarget) -> Result<bool, String> {
    let path = live_path(home, app)?;
    let Some(pre) = read_bytes(&path)? else {
        return Ok(false);
    };
    let (owner_before, owner) = snapshot(home, app, &target.id)?;
    let after = if matches!(app, "opencode" | "openclaw") {
        let Some(Ownership::Additive { before, applied }) = owner else {
            return Ok(false);
        };
        let mut value = parse_json_object(&path, &pre)?;
        let nodes = providers(&mut value, app)?;
        if let Some(node) = nodes.get(&target.id) {
            match restore(node, &applied, before.as_ref()) {
                Some(node) => {
                    nodes.insert(target.id.clone(), node);
                }
                None => {
                    nodes.remove(&target.id);
                }
            }
        }
        Some(pretty(&value)?)
    } else {
        if current(&DeviceStore::for_home(home), app)?.as_deref() != Some(&target.id) {
            return Ok(false);
        };
        let owned = match owner {
            Some(Ownership::Exclusive {
                floor_hash: expected,
            }) => floor_hash(app, &path, &pre)? == expected,
            None => exclusive_bytes(app, Some(&pre), &path, Some(target))?.as_deref() == Some(&pre),
            _ => return Err("Provider ownership snapshot does not match its tool".into()),
        };
        if !owned {
            return Ok(false);
        };
        exclusive_bytes(app, Some(&pre), &path, None)?
    };
    publish_profile(
        home,
        app,
        &target.id,
        plan_from(&LiveFile::private(path), Some(pre), after),
        owner_before,
        None,
        None,
    )?;
    let store = DeviceStore::for_home(home);
    if current(&store, app)?.as_deref() == Some(&target.id) {
        set_current(&store, app, None)?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("lumen-ownership-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn target(model: &str) -> ProviderTarget {
        ProviderTarget::new(
            "fixture",
            "https://fixture.example/v1",
            "fixture-secret",
            model,
        )
        .unwrap()
    }

    #[test]
    fn interrupted_activation_recovers_live_configuration_and_ownership_together() {
        for published in [false, true] {
            let home = Fixture::new();
            let app = "opencode";
            let original = serde_json::json!({"provider":{"fixture":{"keep":"user"}}});
            let path = paths::opencode_config(&home.0);
            atomic_write(&path, &pretty(&original).unwrap(), true).unwrap();
            activate_profile(&home.0, app, &target("model-a")).unwrap();
            let (owner_before, _) = snapshot(&home.0, app, "fixture").unwrap();
            let applied = opencode_node(&target("model-b"));
            let mut next = original.clone();
            merge_profile_fields(&mut next["provider"]["fixture"], applied.clone());
            let owner = Ownership::Additive {
                before: Some(original["provider"]["fixture"].clone()),
                applied,
            };
            let owner_path = snapshot_path(&home.0, app, "fixture");
            let plans = [
                plan_from(
                    &LiveFile::private(path.clone()),
                    read_bytes(&path).unwrap(),
                    Some(pretty(&next).unwrap()),
                ),
                plan_from(
                    &LiveFile::private(owner_path),
                    owner_before,
                    Some(serde_json::to_vec(&owner).unwrap()),
                ),
            ];
            let intent = Pending {
                op: "profile".into(),
                files: plans
                    .iter()
                    .map(|plan| pending_file(plan, stage(plan).unwrap()))
                    .collect(),
                target: None,
                published,
            };
            let store = DeviceStore::for_home(&home.0);
            set_pending(&store, app, Some(intent.clone())).unwrap();
            if published {
                publish(&intent.files[0]).unwrap();
            }
            recover_profile(&home.0, app).unwrap();
            let current = target(if published { "model-b" } else { "model-a" });
            assert!(profile_status(&home.0, app, &current).unwrap().0);
            assert!(remove_managed_profile(&home.0, app, &current).unwrap());
            let restored: Value =
                serde_json::from_slice(&read_bytes(&path).unwrap().unwrap()).unwrap();
            assert!(restored == original);
            assert!(pending(&store, app).unwrap().is_none());
        }
    }

    #[test]
    fn removal_retains_user_enriched_owned_models_and_their_identity() {
        for (app, pointer) in [
            ("opencode", "/provider/fixture"),
            ("openclaw", "/models/providers/fixture"),
        ] {
            let home = Fixture::new();
            let applied = target("model-a");
            activate_profile(&home.0, app, &applied).unwrap();
            let path = live_path(&home.0, app).unwrap();
            let mut value: Value =
                serde_json::from_slice(&read_bytes(&path).unwrap().unwrap()).unwrap();
            let node = value.pointer_mut(pointer).unwrap();
            if app == "opencode" {
                node["models"]["model-a"]["limit"] = serde_json::json!(123);
            } else {
                node["models"][0]["limit"] = serde_json::json!(123);
            }
            atomic_write(&path, &pretty(&value).unwrap(), true).unwrap();
            activate_profile(&home.0, app, &target("model-b")).unwrap();
            remove_managed_profile(&home.0, app, &target("model-b")).unwrap();
            let value: Value =
                serde_json::from_slice(&read_bytes(&path).unwrap().unwrap()).unwrap();
            let node = value.pointer(pointer).unwrap();
            if app == "opencode" {
                assert_eq!(node["models"]["model-a"]["limit"], 123);
            } else {
                assert_eq!(
                    node["models"][0],
                    serde_json::json!({"id":"model-a","name":"model-a","limit":123})
                );
            }
        }
    }

    #[test]
    fn exclusive_ownership_survives_unrelated_external_edits() {
        for app in ["claude", "codex", "gemini"] {
            let home = Fixture::new();
            let applied = target("model-a");
            activate_profile(&home.0, app, &applied).unwrap();
            assert!(
                !String::from_utf8(
                    read_bytes(&snapshot_path(&home.0, app, "fixture"))
                        .unwrap()
                        .unwrap()
                )
                .unwrap()
                .contains("fixture-secret")
            );
            let path = live_path(&home.0, app).unwrap();
            let mut bytes = read_bytes(&path).unwrap().unwrap();
            if app == "claude" {
                let mut value: Value = serde_json::from_slice(&bytes).unwrap();
                value["env"]["USER_FEATURE"] = serde_json::json!("keep");
                bytes = pretty(&value).unwrap();
            } else if app == "codex" {
                bytes.extend_from_slice(b"\n[user]\nkeep = true\n");
            } else {
                bytes.extend_from_slice(b"\n# user comment\n");
            }
            atomic_write(&path, &bytes, true).unwrap();
            assert!(profile_status(&home.0, app, &applied).unwrap().1);
            assert!(remove_managed_profile(&home.0, app, &applied).unwrap());
            assert!(
                String::from_utf8(read_bytes(&path).unwrap().unwrap())
                    .unwrap()
                    .contains(match app {
                        "claude" => "USER_FEATURE",
                        "codex" => "keep = true",
                        _ => "user comment",
                    })
            );
        }
    }

    #[test]
    fn legacy_additive_nodes_and_oversized_ownership_are_never_deleted_or_overwritten() {
        let home = Fixture::new();
        let applied = target("model-a");
        let mut original = serde_json::json!({"provider":{"fixture":{"user":"keep"}}});
        merge_profile_fields(
            &mut original["provider"]["fixture"],
            opencode_node(&applied),
        );
        let path = paths::opencode_config(&home.0);
        atomic_write(&path, &pretty(&original).unwrap(), true).unwrap();
        assert!(!remove_managed_profile(&home.0, "opencode", &applied).unwrap());
        original["provider"]["fixture"]["user"] = Value::String("x".repeat(MAX_TEXT_BYTES - 500));
        atomic_write(&path, &pretty(&original).unwrap(), true).unwrap();
        // The snapshot is bounded independently, before either transaction file is published.
        let owner_path = snapshot_path(&home.0, "opencode", "fixture");
        std::fs::create_dir_all(owner_path.parent().unwrap()).unwrap();
        std::fs::write(&owner_path, vec![b'x'; MAX_TEXT_BYTES + 1]).unwrap();
        let before = read_bytes(&path).unwrap();
        assert!(activate_profile(&home.0, "opencode", &target("model-b")).is_err());
        assert!(read_bytes(&path).unwrap() == before);
    }
}
