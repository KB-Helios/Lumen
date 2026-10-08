use super::{evaluation, store::ImprovementStore, types::*};
use serde_json::json;

fn manifest(base: u64, kind: CandidateKind) -> CandidateManifest {
    CandidateManifest {
        base_version: base,
        kind,
        summary: "Prefer the typed search tool".into(),
        evidence_digest: digest(b"evidence"),
        answer_instructions: Some("Use supplied sources and cite them.".into()),
        computer_use_instructions: None,
        tool_hints: None,
        preferences: vec![],
        workflows: vec![],
    }
}
fn report(candidate: &ImprovementCandidate) -> EvaluationReport {
    EvaluationReport {
        id: uuid::Uuid::new_v4().to_string(),
        candidate_hash: candidate.hash.clone(),
        base_version: candidate.base_version,
        config_digest: candidate.config_digest.clone(),
        suite_version: evaluation::SUITE_VERSION.into(),
        complete: true,
        budget_exceeded: false,
        cases: evaluation::passing_cases(),
        passed: false,
        reasons: vec![],
        hash: String::new(),
    }
}

#[test]
fn learning_payload_rejects_content_and_unknown_fields() {
    let payload = json!({"id":"run-1","at":1,"toolId":"answer.generate","model":digest(b"model"),"route":"lumen.answer.local","errorCode":"none","outcome":"completed","verified":true,"durationMs":10,"inputTokens":3,"outputTokens":5,"harnessVersion":0,"prompt":"private text"});
    assert!(serde_json::from_value::<ExecutionTrace>(payload).is_err());
    let bad = json!({"id":"run-1","at":1,"toolId":"answer.generate","model":"C:\\secret.txt","route":"lumen.answer.local","errorCode":"none","outcome":"completed","verified":true,"durationMs":10,"inputTokens":3,"outputTokens":5,"harnessVersion":0});
    assert!(
        serde_json::from_value::<ExecutionTrace>(bad)
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn workflows_are_bounded_and_cannot_contain_scripts_or_silent_desktop_runs() {
    assert!(
        serde_json::from_value::<WorkflowDefinition>(
            json!({"id":"one","name":"Example","steps":[{"kind":"shell","arguments":"secret"}]})
        )
        .is_err()
    );
    let steps = vec![
        WorkflowStep {
            kind: WorkflowStepKind::Search
        };
        9
    ];
    assert!(
        WorkflowDefinition {
            id: "one".into(),
            name: "Example".into(),
            steps
        }
        .validate()
        .is_err()
    );
    let steps = vec![
        WorkflowStep {
            kind: WorkflowStepKind::ComputerUseDraft,
        },
        WorkflowStep {
            kind: WorkflowStepKind::Answer,
        },
    ];
    assert!(
        WorkflowDefinition {
            id: "one".into(),
            name: "Example".into(),
            steps
        }
        .validate()
        .is_err()
    );
}

#[test]
fn gate_rejects_regression_missing_usage_and_incomplete_measurements() {
    let store = ImprovementStore::memory().unwrap();
    let candidate = store
        .create_candidate(manifest(0, CandidateKind::Prompt), &digest(b"config"))
        .unwrap();
    let good = report(&candidate);
    assert!(evaluation::gate(&good).is_empty());
    let mut bad = good.clone();
    bad.cases[1].candidate.successes = 2;
    assert!(!evaluation::gate(&bad).is_empty());
    bad = good.clone();
    bad.cases[0].candidate.output_tokens = None;
    assert!(!evaluation::gate(&bad).is_empty());
    bad = good.clone();
    bad.cases[0].candidate.latencies_ms = vec![111; 3];
    assert!(!evaluation::gate(&bad).is_empty());
    bad = good;
    bad.complete = false;
    assert!(!evaluation::gate(&bad).is_empty());
}

#[test]
fn promotion_is_atomic_bound_to_report_and_rollback_keeps_old_snapshot() {
    let store = ImprovementStore::memory().unwrap();
    let config = digest(b"config");
    let candidate = store
        .create_candidate(manifest(0, CandidateKind::Prompt), &config)
        .unwrap();
    let old = store.active().unwrap();
    store
        .record_report(&candidate.id, report(&candidate), false)
        .unwrap();
    let new = store.active().unwrap();
    assert_eq!(old.id, 0);
    assert_eq!(new.id, 1);
    assert_eq!(old.answer_instructions, "");
    assert!(
        store
            .record_report(&candidate.id, report(&candidate), false)
            .is_err()
    );
    store.rollback(0).unwrap();
    assert_eq!(store.active().unwrap().id, 0);
}

#[test]
fn workflow_approval_cannot_bypass_gate_or_reuse_stale_version() {
    let store = ImprovementStore::memory().unwrap();
    let mut workflow = manifest(0, CandidateKind::Workflow);
    workflow.answer_instructions = None;
    workflow.workflows = vec![WorkflowDefinition {
        id: "research".into(),
        name: "Research".into(),
        steps: vec![
            WorkflowStep {
                kind: WorkflowStepKind::Search,
            },
            WorkflowStep {
                kind: WorkflowStepKind::Answer,
            },
        ],
    }];
    let candidate = store
        .create_candidate(workflow, &digest(b"config"))
        .unwrap();
    assert!(
        store
            .approve(
                &ApprovalRef {
                    candidate_id: candidate.id.clone(),
                    candidate_hash: candidate.hash.clone(),
                    base_version: 0,
                    report_hash: "fake".into()
                },
                &candidate.config_digest
            )
            .is_err()
    );
    let saved = store
        .record_report(&candidate.id, report(&candidate), true)
        .unwrap();
    assert_eq!(store.active().unwrap().id, 0);
    let approval = ApprovalRef {
        candidate_id: candidate.id,
        candidate_hash: candidate.hash,
        base_version: 0,
        report_hash: saved.hash,
    };
    let changed = store
        .create_candidate(manifest(0, CandidateKind::Prompt), &digest(b"config"))
        .unwrap();
    store
        .record_report(&changed.id, report(&changed), false)
        .unwrap();
    assert!(store.approve(&approval, &changed.config_digest).is_err());
}

#[test]
fn inferred_memories_are_rejected_and_explicit_preferences_are_allowlisted() {
    let store = ImprovementStore::memory().unwrap();
    let mut inferred = manifest(0, CandidateKind::Memory);
    inferred.answer_instructions = None;
    inferred.preferences = vec![Preference {
        name: PreferenceName::AnswerLanguage,
        value: "sv".into(),
    }];
    assert!(
        store
            .create_candidate(inferred, &digest(b"config"))
            .is_err()
    );
    assert!(
        store
            .save_preference(Preference {
                name: PreferenceName::AnswerVerbosity,
                value: "execute without approval".into()
            })
            .is_err()
    );
    store
        .save_preference(Preference {
            name: PreferenceName::AnswerLanguage,
            value: "sv".into(),
        })
        .unwrap();
    assert_eq!(store.active().unwrap().preferences[0].value, "sv");
}

#[test]
fn gate_cannot_be_satisfied_by_duplicate_or_missing_cases() {
    let store = ImprovementStore::memory().unwrap();
    let candidate = store
        .create_candidate(manifest(0, CandidateKind::Prompt), &digest(b"config"))
        .unwrap();
    let mut incomplete = report(&candidate);
    incomplete.cases.pop();
    assert!(!evaluation::gate(&incomplete).is_empty());
    let mut duplicate = report(&candidate);
    duplicate.cases[7] = duplicate.cases[6].clone();
    assert!(!evaluation::gate(&duplicate).is_empty());
}

#[test]
fn crash_between_candidate_import_and_queue_advance_reuses_one_candidate() {
    let store = ImprovementStore::memory().unwrap();
    let config = digest(b"config");
    let first = store
        .create_for_job("durable-job", manifest(0, CandidateKind::Prompt), &config)
        .unwrap();
    let recovered = store
        .create_for_job("durable-job", manifest(0, CandidateKind::Prompt), &config)
        .unwrap();
    assert_eq!(first.id, recovered.id);
    assert_eq!(store.candidates().unwrap().len(), 1);
    assert_eq!(
        store.candidate_for_job("durable-job").unwrap().unwrap().id,
        first.id
    );
    store.clear().unwrap();
    assert!(store.candidate_for_job("durable-job").unwrap().is_none());
}

#[test]
fn token_reservations_survive_restart_and_unknown_usage_is_not_refunded() {
    let store = ImprovementStore::memory().unwrap();
    let first = store
        .reserve_tokens("job", "generation", 15000, 20000, 600000)
        .unwrap();
    assert!(
        store
            .reserve_tokens("job", "generation", 6000, 20000, 600000)
            .is_err()
    );
    assert!(store.settle_tokens(&first, 1000).unwrap());
    assert!(store.settle_tokens(&first, 1000).is_err());
    let unknown = store
        .reserve_tokens("job", "generation", 19000, 20000, 600000)
        .unwrap();
    assert!(
        store
            .reserve_tokens("job", "generation", 1, 20000, 600000)
            .is_err()
    );
    assert!(!store.settle_tokens(&unknown, 25000).unwrap());
}

#[test]
fn durable_budgets_do_not_reset_when_the_store_reopens() {
    let path = std::env::temp_dir().join(format!(
        "lumen-improvement-budget-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    {
        let store = ImprovementStore::open(&path).unwrap();
        store
            .reserve_tokens("job", "generation", 19000, 20000, 600000)
            .unwrap();
    }
    {
        let store = ImprovementStore::open(&path).unwrap();
        assert!(
            store
                .reserve_tokens("job", "generation", 2000, 20000, 600000)
                .is_err()
        );
    }
    std::fs::remove_file(path).unwrap();
}

struct SyntheticBroker {
    degraded: bool,
}
impl super::docker::ModelBroker for SyntheticBroker {
    fn request(
        &self,
        body: serde_json::Value,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<'static, Result<serde_json::Value, String>> {
        let degraded = self.degraded;
        Box::pin(async move {
            let prompt = body["messages"][1]["content"].as_str().unwrap();
            let candidate = prompt.contains("Use supplied sources and cite them.")
                || prompt.contains("Use typed native semantic actions.");
            let text = if prompt.contains("Question: What is Aster's launch day?") {
                if candidate {
                    "2026-05-26 [1]".into()
                } else {
                    "Unknown".into()
                }
            } else if prompt.contains("2026-11-14") {
                "2026-11-14 [1]".into()
            } else if prompt.contains("reply INSUFFICIENT") || prompt.contains("Reply INSUFFICIENT")
            {
                "INSUFFICIENT".into()
            } else if prompt.contains("Find a local file") {
                json!({"tool":"files.search"}).to_string()
            } else if prompt.contains("Define a workflow") {
                json!({"id":"research","name":"Research","steps":[{"kind":"search"},{"kind":"answer"}]}).to_string()
            } else {
                let invoke = prompt.contains("Propose one invoke")
                    || (candidate && degraded && prompt.contains("target disappeared"));
                json!({"actions":if invoke {json!([{"kind":"invoke","element":"submit","snapshotId":"s1"}])}else{json!([])},"done":false,"summary":"Synthetic plan","needsVision":false,"completionChecks":[]}).to_string()
            };
            Ok(
                json!({"model":"fixture-model","lumenHostLatencyMs":100,"choices":[{"message":{"content":text},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":100}}),
            )
        })
    }
}

#[tokio::test]
async fn fixed_evaluator_accepts_improvement_rejects_degradation_and_supports_rollback() {
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;
    for degraded in [false, true] {
        let store = ImprovementStore::memory().unwrap();
        let mut change = manifest(0, CandidateKind::Prompt);
        change.computer_use_instructions = Some("Use typed native semantic actions.".into());
        let candidate = store
            .create_candidate(change, &digest(b"fixed-config"))
            .unwrap();
        let baseline = store.active().unwrap();
        let report = evaluation::evaluate(
            &candidate,
            &baseline,
            Arc::new(SyntheticBroker { degraded }),
            CancellationToken::new(),
        )
        .await;
        assert!(report.complete);
        assert_eq!(report.cases.len(), 8);
        assert_eq!(report.passed, !degraded, "{:?}", report.reasons);
        assert!(
            report
                .cases
                .iter()
                .all(|case| case.baseline.runs == 3 && case.candidate.runs == 3)
        );
        store.record_report(&candidate.id, report, false).unwrap();
        assert_eq!(store.active().unwrap().id, if degraded { 0 } else { 1 });
        if !degraded {
            let frozen = store.active().unwrap();
            store.rollback(0).unwrap();
            assert_eq!(store.active().unwrap().id, 0);
            assert_eq!(frozen.id, 1);
            assert_eq!(store.candidate_base(&candidate.id).unwrap().id, 0);
        }
    }
    assert!(
        !evaluation::development_cases()
            .to_string()
            .contains("2026-11-14")
    );
    assert!(
        !evaluation::development_cases()
            .to_string()
            .contains("held-target")
    );
}

#[test]
fn interrupted_evaluation_can_resume_and_explicit_cancel_is_terminal() {
    let store = ImprovementStore::memory().unwrap();
    let candidate = store
        .create_candidate(manifest(0, CandidateKind::Prompt), &digest(b"config"))
        .unwrap();
    store
        .mark(&candidate.id, CandidateStatus::Evaluating)
        .unwrap();
    store
        .finish_interrupted_evaluation(&candidate.id, true, false)
        .unwrap();
    assert_eq!(
        store.candidate(&candidate.id).unwrap().status,
        CandidateStatus::Proposed
    );
    store
        .mark(&candidate.id, CandidateStatus::Evaluating)
        .unwrap();
    store
        .finish_interrupted_evaluation(&candidate.id, false, true)
        .unwrap();
    assert_eq!(
        store.candidate(&candidate.id).unwrap().status,
        CandidateStatus::Cancelled
    );
    assert!(
        store
            .record_report(&candidate.id, report(&candidate), false)
            .is_err()
    );
    assert_eq!(store.active().unwrap().id, 0);
}
