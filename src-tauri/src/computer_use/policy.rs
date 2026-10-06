use super::protocol::*;
use crate::consent::PersistedConsent;

#[derive(Default)]
pub struct Budget {
    pub provider_turns: u32,
    pub executed_actions: u32,
}
impl Budget {
    pub fn turn(&mut self) -> Result<(), String> {
        if self.provider_turns >= 60 {
            return Err("Provider turn limit reached (60)".to_owned());
        }
        self.provider_turns += 1;
        Ok(())
    }
    pub fn action(&mut self) -> Result<(), String> {
        if self.executed_actions >= 60 {
            return Err("Executed action limit reached (60)".to_owned());
        }
        self.executed_actions += 1;
        Ok(())
    }
}
use std::collections::HashSet;

pub fn validate_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Use an absolute HTTP(S) URL")?;
    if value.len() > 4096
        || !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use an absolute HTTP(S) URL without credentials".to_owned());
    }
    Ok(())
}
pub fn validate_request(
    request: &ComputerUseRequest,
    consent: &PersistedConsent,
) -> Result<(), String> {
    if request.task_id == 0
        || request.task_id > 9_007_199_254_740_991
        || request.task.trim().is_empty()
        || request.task.chars().count() > 4000
    {
        return Err("Enter a task of 1 to 4,000 characters".to_owned());
    }
    if !request.provider.models().contains(&request.model.as_str()) {
        return Err("The saved model is unavailable for this provider".to_owned());
    }
    match &request.target {
        TargetSelection::Browser {
            initial_url,
            visible,
        } => {
            validate_url(initial_url)?;
            if *visible && request.execution_mode == ExecutionMode::Background {
                return Err("Background browser tasks cannot open a visible window".to_owned());
            }
            if !request.cloud_consent || !consent.computer_use_granted() {
                return Err("Recorded browser cloud consent is required".to_owned());
            }
        }
        TargetSelection::Window { target_id } => {
            if target_id.len() != 36 || uuid::Uuid::parse_str(target_id).is_err() {
                return Err("Select an available Windows window".to_owned());
            }
            if !request.desktop_control_consent
                || !request.desktop_cloud_consent
                || !consent.desktop_control_granted()
                || !consent.desktop_cloud_granted()
            {
                return Err(
                    "Recorded desktop control and desktop cloud consent are required".to_owned(),
                );
            }
        }
    }
    Ok(())
}
pub fn consent_current(request: &ComputerUseRequest, consent: &PersistedConsent) -> bool {
    match request.target {
        TargetSelection::Browser { .. } => consent.computer_use_granted(),
        TargetSelection::Window { .. } => {
            consent.desktop_control_granted() && consent.desktop_cloud_granted()
        }
    }
}
pub fn validate_observation(observation: &Observation) -> Result<(), String> {
    if observation.snapshot_id.is_empty()
        || observation.snapshot_id.len() > 128
        || observation.elements.len() > 300
        || observation.title.len() > 4096
        || !observation.width.is_finite()
        || !observation.height.is_finite()
        || observation.width <= 0.0
        || observation.height <= 0.0
        || observation.width > 16384.0
        || observation.height > 16384.0
    {
        return Err("invalid_observation".to_owned());
    }
    if let Some(url) = &observation.url {
        validate_url(url)?;
    }
    let mut refs = HashSet::new();
    for element in &observation.elements {
        if element.reference.is_empty()
            || element.reference.len() > 512
            || !refs.insert(&element.reference)
            || element.name.len() > 4096
            || element.role.len() > 128
            || element.value.as_ref().is_some_and(|v| v.len() > 16384)
            || element
                .actions
                .iter()
                .any(|a| !["invoke", "setValue", "select", "scroll"].contains(&a.as_str()))
        {
            return Err("invalid_element".to_owned());
        }
        if let Some(b) = &element.bounds
            && ([b.x, b.y, b.width, b.height].iter().any(|v| !v.is_finite())
                || b.width < 0.0
                || b.height < 0.0)
        {
            return Err("invalid_bounds".to_owned());
        }
    }
    if let Some(image) = &observation.screenshot {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&image.data)
            .map_err(|_| "invalid_image")?;
        if image.mime_type != "image/png"
            || bytes.len() > 10 * 1024 * 1024
            || bytes.len() < 24
            || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
            || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != observation.width as u32
            || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != observation.height as u32
        {
            return Err("invalid_image".to_owned());
        }
    }
    Ok(())
}
pub fn validate_action(action: &Action, observation: &Observation) -> Result<(), String> {
    use ActionKind::*;
    if action
        .text
        .as_ref()
        .is_some_and(|v| v.chars().count() > 4000)
        || action.element.as_ref().is_some_and(|v| v.len() > 512)
    {
        return Err("invalid_action".to_owned());
    }
    let semantic = matches!(action.kind, Invoke | SetValue | Select)
        || action.kind == Scroll && action.element.is_some();
    if semantic {
        let reference = action.element.as_ref().ok_or("element_required")?;
        let element = observation
            .elements
            .iter()
            .find(|e| &e.reference == reference)
            .ok_or("stale_snapshot")?;
        if !element.enabled || !element.actions.iter().any(|a| a == action.kind.id()) {
            return Err("semantic_action_unavailable".to_owned());
        }
    } else if action.element.is_some() {
        return Err("invalid_action_fields".to_owned());
    }
    if action.text.is_some() != matches!(action.kind, SetValue | Select | Type)
        || action.url.is_some() != (action.kind == Navigate)
        || action.keys.is_some() != (action.kind == Keypress)
    {
        return Err("invalid_action_fields".to_owned());
    }
    if let Some(url) = &action.url {
        validate_url(url)?;
    }
    if let Some(keys) = &action.keys
        && (keys.is_empty() || keys.len() > 5 || keys.iter().any(|k| !valid_key(k)))
    {
        return Err("invalid_keys".to_owned());
    }
    if action.kind.coordinates() {
        if observation.screenshot.is_none() {
            return Err("screenshot_required".to_owned());
        }
        let (x, y) = (
            action.x.ok_or("coordinate_required")?,
            action.y.ok_or("coordinate_required")?,
        );
        if !point_valid(x, y, observation) {
            return Err("invalid_coordinates".to_owned());
        }
        if action.kind == Drag {
            if !point_valid(
                action.end_x.ok_or("coordinate_required")?,
                action.end_y.ok_or("coordinate_required")?,
                observation,
            ) {
                return Err("invalid_coordinates".to_owned());
            }
        } else if action.end_x.is_some() || action.end_y.is_some() {
            return Err("invalid_action_fields".to_owned());
        }
    } else if action.x.is_some()
        || action.y.is_some()
        || action.end_x.is_some()
        || action.end_y.is_some()
    {
        return Err("invalid_action_fields".to_owned());
    }
    match action.kind {
        Wait => {
            let amount = action.amount.ok_or("duration_required")?;
            if !amount.is_finite()
                || !(0.0..=5000.0).contains(&amount)
                || amount.fract() != 0.0
                || action.direction.is_some()
            {
                return Err("invalid_wait".to_owned());
            }
        }
        Scroll => {
            if !action
                .amount
                .is_some_and(|v| v.is_finite() && v.fract() == 0.0 && (1.0..=3000.0).contains(&v))
                || !action
                    .direction
                    .as_ref()
                    .is_some_and(|d| ["up", "down", "left", "right"].contains(&d.as_str()))
            {
                return Err("invalid_scroll".to_owned());
            }
        }
        _ => {
            if action.amount.is_some() || action.direction.is_some() {
                return Err("invalid_action_fields".to_owned());
            }
        }
    }
    Ok(())
}
pub fn valid_key(key: &str) -> bool {
    key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric())
        || [
            "Enter",
            "Tab",
            "Escape",
            "Backspace",
            "Delete",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Space",
            "Control",
            "Ctrl",
            "Alt",
            "Shift",
            "F1",
            "F2",
            "F3",
            "F4",
            "F5",
            "F6",
            "F7",
            "F8",
            "F9",
            "F10",
            "F11",
            "F12",
        ]
        .contains(&key)
}
fn point_valid(x: f64, y: f64, o: &Observation) -> bool {
    x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 && x < o.width && y < o.height
}
/// Reuse a refused pixel proposal only when a fresh capture proves unchanged
/// target pixels and geometry. A new capture ID alone does not prove this.
pub fn pixels_unchanged(old: &Observation, current: &Observation) -> bool {
    !old.degraded
        && !current.degraded
        && old.width == current.width
        && old.height == current.height
        && old.url == current.url
        && old
            .screenshot
            .as_ref()
            .zip(current.screenshot.as_ref())
            .is_some_and(|(a, b)| a.mime_type == b.mime_type && a.data == b.data)
}
pub fn approval_state_matches(
    action: &Action,
    approved: &Observation,
    current: &Observation,
) -> bool {
    if approved.degraded
        || current.degraded
        || approved.width != current.width
        || approved.height != current.height
        || approved.url != current.url
    {
        return false;
    }
    if action.element.is_some() {
        let mut rebound = action.clone();
        if rebind(&mut rebound, approved, current).is_err() {
            return false;
        }
        let old = approved
            .elements
            .iter()
            .find(|e| Some(&e.reference) == action.element.as_ref());
        let fresh = current
            .elements
            .iter()
            .find(|e| Some(&e.reference) == rebound.element.as_ref());
        old.zip(fresh).is_some_and(|(a, b)| {
            a.bounds == b.bounds && a.value == b.value && a.enabled == b.enabled
        })
    } else {
        pixels_unchanged(approved, current)
    }
}

fn unique_completion_element<'a>(
    source: &Element,
    state: &'a Observation,
    match_name: bool,
) -> Option<&'a Element> {
    let mut matching = state.elements.iter().filter(|e| {
        e.role == source.role
            && (!match_name || e.name == source.name)
            && e.automation_id == source.automation_id
            && (source
                .automation_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
                || source.bounds.is_some() && e.bounds == source.bounds
                || match_name && e.bounds == source.bounds)
    });
    let found = matching.next()?;
    matching.next().is_none().then_some(found)
}
fn check_matches(check: &CompletionCheck, proposed: &Observation, state: &Observation) -> bool {
    match check.kind {
        CompletionCheckKind::Value | CompletionCheckKind::Name => {
            let Some(source) = proposed
                .elements
                .iter()
                .find(|e| Some(&e.reference) == check.element.as_ref())
            else {
                return false;
            };
            unique_completion_element(source, state, true).is_some_and(|element| match check.kind {
                CompletionCheckKind::Value => {
                    element.value.as_deref() == Some(check.expected.as_str())
                }
                CompletionCheckKind::Name => element.name == check.expected,
                _ => false,
            })
        }
        CompletionCheckKind::Url => {
            check.element.is_none() && state.url.as_deref() == Some(check.expected.as_str())
        }
        CompletionCheckKind::Title => check.element.is_none() && state.title == check.expected,
    }
}
pub fn verify_completion(
    checks: &[CompletionCheck],
    proposed: &Observation,
    fresh: &Observation,
) -> Result<(), String> {
    if checks.is_empty()
        || checks.len() > 10
        || proposed.degraded
        || fresh.degraded
        || proposed.snapshot_id == fresh.snapshot_id
    {
        return Err("completion_verification_required".to_owned());
    }
    for check in checks {
        if (!matches!(check.kind, CompletionCheckKind::Value) && check.expected.trim().is_empty())
            || check.expected.chars().count() > 4000
            || check
                .element
                .as_ref()
                .is_some_and(|e| e.is_empty() || e.len() > 512)
        {
            return Err("invalid_completion_check".to_owned());
        }
        if !check_matches(check, proposed, proposed) || !check_matches(check, proposed, fresh) {
            return Err("completion_state_changed".to_owned());
        }
    }
    Ok(())
}

/// Unverified delivery admits bounded observation and a finish proposal only.
/// Capturing another snapshot never authorizes another input action.
pub struct OutcomeReview {
    before: Observation,
    vision_requested: bool,
}
impl OutcomeReview {
    pub fn new(before: Observation) -> Self {
        Self {
            before,
            vision_requested: false,
        }
    }
    pub fn admit_plan(&mut self, plan: &ActionPlan, vision: bool) -> Result<(), String> {
        if !plan.actions.is_empty() {
            return Err("uncertain_action_replay_forbidden".to_owned());
        }
        if plan.done && !plan.needs_vision {
            return Ok(());
        }
        if plan.needs_vision && !vision && !self.vision_requested && !plan.done {
            self.vision_requested = true;
            return Ok(());
        }
        Err("uncertain_outcome_not_established".to_owned())
    }
    pub fn verify(
        &self,
        plan: &ActionPlan,
        proposed: &Observation,
        fresh: &Observation,
    ) -> Result<(), String> {
        if !plan.done || plan.needs_vision || !plan.actions.is_empty() {
            return Err("uncertain_action_replay_forbidden".to_owned());
        }
        verify_completion(&plan.completion_checks, proposed, fresh)?;
        if self.before.degraded || self.before.snapshot_id == proposed.snapshot_id {
            return Err("uncertain_outcome_not_established".to_owned());
        }
        let changed = plan.completion_checks.iter().any(|check| match check.kind {
            CompletionCheckKind::Name | CompletionCheckKind::Value => {
                let source = proposed
                    .elements
                    .iter()
                    .find(|e| Some(&e.reference) == check.element.as_ref());
                source
                    .and_then(|e| {
                        unique_completion_element(
                            e,
                            &self.before,
                            matches!(check.kind, CompletionCheckKind::Value),
                        )
                    })
                    .is_some_and(|old| match check.kind {
                        CompletionCheckKind::Name => old.name != check.expected,
                        CompletionCheckKind::Value => old
                            .value
                            .as_deref()
                            .is_some_and(|value| value != check.expected),
                        _ => false,
                    })
            }
            CompletionCheckKind::Url => self
                .before
                .url
                .as_ref()
                .is_some_and(|url| url != &check.expected),
            CompletionCheckKind::Title => self.before.title != check.expected,
        });
        if changed {
            Ok(())
        } else {
            Err("uncertain_outcome_not_established".to_owned())
        }
    }
}

/// End a verified batch when the planner must inspect a new interaction context.
pub fn batch_boundary(
    action: &Action,
    approval_boundary: bool,
    before: &Observation,
    after: &Observation,
) -> bool {
    action.kind == ActionKind::Navigate || approval_boundary || before.url != after.url
}

/// Rebind a remaining batch action only when its semantic descriptor is unique.
pub fn rebind(action: &mut Action, old: &Observation, current: &Observation) -> Result<(), String> {
    if let Some(reference) = &action.element {
        let source = old
            .elements
            .iter()
            .find(|e| &e.reference == reference)
            .ok_or("stale_snapshot")?;
        let matching: Vec<_> = current
            .elements
            .iter()
            .filter(|e| {
                e.role == source.role
                    && e.name == source.name
                    && e.automation_id == source.automation_id
                    && (source.automation_id.is_some() || e.bounds == source.bounds)
                    && e.enabled
                    && e.actions.contains(&action.kind.id().to_owned())
            })
            .collect();
        if current.degraded || matching.len() != 1 {
            return Err("ambiguous_target".to_owned());
        }
        action.element = Some(matching[0].reference.clone());
    } else if action.kind.coordinates() {
        return Err("refresh_coordinates".to_owned());
    }
    validate_action(action, current)
}
/// Coordinates become semantic actions only for a single supported element.
pub fn semantic_coordinate(action: &Action, observation: &Observation) -> Option<Action> {
    if action.kind != ActionKind::Click {
        return None;
    }
    let (x, y) = (action.x?, action.y?);
    let matches: Vec<_> = observation
        .elements
        .iter()
        .filter(|e| {
            e.enabled
                && e.actions.iter().any(|a| a == "invoke")
                && e.bounds.as_ref().is_some_and(|b| {
                    x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height
                })
        })
        .collect();
    if matches.len() != 1 {
        return None;
    }
    Some(Action {
        kind: ActionKind::Invoke,
        element: Some(matches[0].reference.clone()),
        text: None,
        url: None,
        keys: None,
        x: None,
        y: None,
        end_x: None,
        end_y: None,
        direction: None,
        amount: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observation() -> Observation {
        serde_json::from_value(serde_json::json!({"snapshotId":"s1","title":"Fixture","elements":[{"ref":"a","role":"textbox","name":"Name","automationId":"name","enabled":true,"actions":["setValue"]}],"width":800,"height":600})).unwrap()
    }
    #[test]
    fn batch_boundary_requires_replanning_after_observed_browser_url_change() {
        let mut before = observation();
        before.url = Some("https://example.com/form".into());
        let mut after = before.clone();
        after.snapshot_id = "fresh".into();
        after.url = Some("https://example.com/submitted".into());
        for action in [
            serde_json::json!({"kind":"setValue","element":"a","text":"submitted"}),
            serde_json::json!({"kind":"wait","amount":1000}),
        ] {
            let action: Action = serde_json::from_value(action).unwrap();
            assert!(batch_boundary(&action, false, &before, &after));
            assert!(!batch_boundary(&action, false, &before, &before));
            assert!(batch_boundary(&action, true, &before, &before));
            let native = observation();
            assert!(!batch_boundary(&action, false, &native, &native));
            assert!(batch_boundary(&action, true, &native, &native));
        }
        let navigate: Action = serde_json::from_value(
            serde_json::json!({"kind":"navigate","url":"https://example.com/form"}),
        )
        .unwrap();
        assert!(batch_boundary(&navigate, false, &before, &before));
    }
    #[test]
    fn forbids_private_navigation_and_worker_extensions() {
        for url in [
            "file:///C:/secret",
            "javascript:alert(1)",
            "https://me:secret@example.com",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert!(
            serde_json::from_value::<Action>(
                serde_json::json!({"kind":"type","text":"hi","script":"evil"})
            )
            .is_err()
        );
    }
    #[test]
    fn rebinds_only_unique_semantic_controls_and_never_coordinates() {
        let old = observation();
        let mut current = old.clone();
        current.elements[0].reference = "b".into();
        let mut action: Action = serde_json::from_value(
            serde_json::json!({"kind":"setValue","element":"a","text":"Kevin"}),
        )
        .unwrap();
        rebind(&mut action, &old, &current).unwrap();
        assert_eq!(action.element.as_deref(), Some("b"));
        action.element = Some("a".into());
        current.elements.push(current.elements[0].clone());
        assert!(rebind(&mut action, &old, &current).is_err());
    }
    #[test]
    fn rejects_stale_snapshots_and_unrelated_action_fields() {
        let mut a: Action = serde_json::from_value(
            serde_json::json!({"kind":"setValue","element":"gone","text":"x"}),
        )
        .unwrap();
        assert!(validate_action(&a, &observation()).is_err());
        a.element = Some("a".into());
        a.x = Some(12.0);
        assert!(validate_action(&a, &observation()).is_err());
    }
    #[test]
    fn approval_refuses_changed_values_and_pixel_captures() {
        let approved = observation();
        let action: Action = serde_json::from_value(
            serde_json::json!({"kind":"setValue","element":"a","text":"Fixture"}),
        )
        .unwrap();
        let mut current = approved.clone();
        current.snapshot_id = "s2".into();
        current.elements[0].reference = "b".into();
        assert!(approval_state_matches(&action, &approved, &current));
        current.elements[0].value = Some("User editing".into());
        assert!(!approval_state_matches(&action, &approved, &current));
        assert!(!pixels_unchanged(&approved, &current));
        let mut captured = approved.clone();
        captured.screenshot = Some(Image {
            mime_type: "image/png".into(),
            data: "fixture-pixels".into(),
        });
        current = captured.clone();
        current.snapshot_id = "fresh".into();
        assert!(pixels_unchanged(&captured, &current));
        current.screenshot.as_mut().unwrap().data = "changed-pixels".into();
        assert!(!pixels_unchanged(&captured, &current));
    }
    #[test]
    fn completion_requires_fresh_matching_application_state_not_a_summary() {
        let mut proposed = observation();
        proposed.elements[0].value = Some("Expected fixture".into());
        let check = CompletionCheck {
            kind: CompletionCheckKind::Value,
            element: Some("a".into()),
            expected: "Expected fixture".into(),
        };
        let mut fresh = proposed.clone();
        fresh.snapshot_id = "fresh".into();
        fresh.elements[0].reference = "b".into();
        assert!(verify_completion(&[], &proposed, &fresh).is_err());
        assert!(verify_completion(std::slice::from_ref(&check), &proposed, &fresh).is_ok());
        fresh.elements[0].value = Some("User changed it".into());
        assert!(verify_completion(std::slice::from_ref(&check), &proposed, &fresh).is_err());
        fresh.elements[0].value = Some(check.expected.clone());
        fresh.elements.push(fresh.elements[0].clone());
        assert!(verify_completion(&[check], &proposed, &fresh).is_err());
    }
    fn finish_plan(check: CompletionCheck) -> ActionPlan {
        ActionPlan {
            actions: vec![],
            done: true,
            summary: "Submitted".into(),
            needs_vision: false,
            completion_checks: vec![check],
        }
    }
    fn submitted_state() -> Observation {
        serde_json::from_value(serde_json::json!({"snapshotId":"result","title":"Fixture","elements":[{"ref":"status","role":"status","name":"Submitted","automationId":"result","enabled":true,"actions":[]}],"width":800,"height":600})).unwrap()
    }
    #[test]
    fn outcome_review_accepts_fresh_changed_status_but_not_delivery_or_unchanged_title() {
        let proposed = submitted_state();
        let mut before = proposed.clone();
        before.snapshot_id = "before".into();
        before.elements[0].name = "Ready".into();
        let mut fresh = proposed.clone();
        fresh.snapshot_id = "fresh".into();
        fresh.elements[0].reference = "fresh-status".into();
        let review = OutcomeReview::new(before.clone());
        let check = CompletionCheck {
            kind: CompletionCheckKind::Name,
            element: Some("status".into()),
            expected: "Submitted".into(),
        };
        let plan = finish_plan(check);
        assert!(review.verify(&plan, &proposed, &fresh).is_ok());
        let title = finish_plan(CompletionCheck {
            kind: CompletionCheckKind::Title,
            element: None,
            expected: "Fixture".into(),
        });
        assert!(review.verify(&title, &proposed, &fresh).is_err());
        fresh.elements[0].name = "User changed result".into();
        assert!(review.verify(&plan, &proposed, &fresh).is_err());
        fresh.elements[0].name = "Submitted".into();
        before = proposed.clone();
        before.snapshot_id = "before".into();
        before.elements[0].name = "Ready".into();
        before.elements.push(before.elements[0].clone());
        assert!(
            OutcomeReview::new(before.clone())
                .verify(&plan, &proposed, &fresh)
                .is_err()
        );
        // Bounded snapshots cannot prove an absent element was newly created.
        before.elements.clear();
        let review = OutcomeReview::new(before);
        fresh.elements[0].name = "Submitted".into();
        assert!(review.verify(&plan, &proposed, &fresh).is_err());
    }
    #[test]
    fn outcome_review_forbids_input_and_allows_only_one_vision_transition() {
        let mut review = OutcomeReview::new(observation());
        let mut plan = ActionPlan {
            actions: vec![],
            done: false,
            summary: "".into(),
            needs_vision: true,
            completion_checks: vec![],
        };
        assert!(review.admit_plan(&plan, false).is_ok());
        assert!(review.admit_plan(&plan, true).is_err());
        assert!(review.admit_plan(&plan, false).is_err());
        plan.needs_vision = false;
        plan.actions = vec![
            serde_json::from_value(serde_json::json!({"kind":"keypress","keys":["Enter"]}))
                .unwrap(),
        ];
        assert!(review.admit_plan(&plan, true).is_err());
        plan.actions.clear();
        assert!(review.admit_plan(&plan, true).is_err());
    }
    #[test]
    fn completion_checks_require_current_unique_proposal_and_fresh_nondegraded_state() {
        let proposed = observation();
        let check = CompletionCheck {
            kind: CompletionCheckKind::Value,
            element: Some("a".into()),
            expected: "Expected".into(),
        };
        let mut fresh = proposed.clone();
        fresh.snapshot_id = "fresh".into();
        fresh.elements[0].value = Some("Expected".into());
        assert!(verify_completion(std::slice::from_ref(&check), &proposed, &fresh).is_err());
        let mut proposed = fresh.clone();
        proposed.snapshot_id = "proposed".into();
        assert!(verify_completion(std::slice::from_ref(&check), &proposed, &fresh).is_ok());
        fresh.degraded = true;
        assert!(verify_completion(std::slice::from_ref(&check), &proposed, &fresh).is_err());
        fresh.degraded = false;
        fresh.snapshot_id = proposed.snapshot_id.clone();
        assert!(verify_completion(&[check], &proposed, &fresh).is_err());
    }
    #[test]
    fn budgets_allow_exactly_sixty_turns_and_inputs_independently() {
        let mut budget = Budget::default();
        for _ in 0..60 {
            budget.turn().unwrap();
            budget.action().unwrap();
        }
        assert!(budget.turn().is_err());
        assert!(budget.action().is_err());
        assert_eq!(budget.provider_turns, 60);
        assert_eq!(budget.executed_actions, 60);
    }
}
