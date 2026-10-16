use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const DEFERRED: &str = "enrichment_budget_deferred";
const UNAVAILABLE: &str = "Enrichment budget storage or usage is unavailable.";
const LIMIT: i64 = 500_000;
const DAY: i64 = 24 * 60 * 60 * 1000;
pub(crate) struct EnrichmentBudget {
    connection: Mutex<Connection>,
    unavailable: std::sync::atomic::AtomicBool,
}
pub(crate) struct Reservation {
    budget: Arc<EnrichmentBudget>,
    id: String,
    window: i64,
    settled: bool,
}

impl EnrichmentBudget {
    pub(crate) fn open(path: &Path) -> Result<Arc<Self>, String> {
        let connection = Connection::open(path).map_err(|_| UNAVAILABLE)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| UNAVAILABLE)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS enrichment_budget(id INTEGER PRIMARY KEY CHECK(id=1),window_start INTEGER NOT NULL,used INTEGER NOT NULL,blocked INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS enrichment_requests(id TEXT PRIMARY KEY,requested_at INTEGER NOT NULL,window_start INTEGER NOT NULL,reserved INTEGER NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX IF NOT EXISTS enrichment_request_time ON enrichment_requests(requested_at);
          UPDATE enrichment_budget SET blocked=1 WHERE EXISTS(SELECT 1 FROM enrichment_requests WHERE settled=0 AND window_start=enrichment_budget.window_start);").map_err(|_| UNAVAILABLE)?;
        Ok(Arc::new(Self {
            connection: Mutex::new(connection),
            unavailable: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    pub(crate) fn reserve(self: &Arc<Self>, estimate: Option<u64>) -> Result<Reservation, String> {
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| UNAVAILABLE)?
                .as_millis(),
        )
        .map_err(|_| UNAVAILABLE)?;
        self.reserve_at(estimate, now)
    }
    fn reserve_at(
        self: &Arc<Self>,
        estimate: Option<u64>,
        now: i64,
    ) -> Result<Reservation, String> {
        if self.unavailable.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(UNAVAILABLE.into());
        }
        let mut connection = self.connection.lock().map_err(|_| UNAVAILABLE)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| UNAVAILABLE)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO enrichment_budget VALUES(1,?1,0,0)",
                [now],
            )
            .map_err(|_| UNAVAILABLE)?;
        let (mut start, mut used, mut blocked): (i64, i64, i64) = transaction
            .query_row(
                "SELECT window_start,used,blocked FROM enrichment_budget WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| UNAVAILABLE)?;
        if now < start || used < 0 || !matches!(blocked, 0 | 1) {
            return Err(UNAVAILABLE.into());
        }
        if now >= start.saturating_add(DAY) {
            start = now;
            used = 0;
            blocked = 0;
            transaction
                .execute(
                    "UPDATE enrichment_budget SET window_start=?1,used=0,blocked=0 WHERE id=1",
                    [now],
                )
                .map_err(|_| UNAVAILABLE)?;
            transaction
                .execute(
                    "DELETE FROM enrichment_requests WHERE requested_at<=?1",
                    [now - 60000],
                )
                .map_err(|_| UNAVAILABLE)?;
        }
        let count: i64 = transaction
            .query_row(
                "SELECT count(*) FROM enrichment_requests WHERE requested_at>?1",
                [now - 60000],
                |row| row.get(0),
            )
            .map_err(|_| UNAVAILABLE)?;
        let remaining = LIMIT.saturating_sub(used);
        let amount = match estimate {
            Some(value) => i64::try_from(value).map_err(|_| DEFERRED)?,
            None => remaining,
        };
        if count >= 10 || blocked != 0 || amount <= 0 || amount > remaining {
            return Err(DEFERRED.into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        transaction
            .execute(
                "UPDATE enrichment_budget SET used=used+?1 WHERE id=1",
                [amount],
            )
            .map_err(|_| UNAVAILABLE)?;
        transaction.execute("INSERT INTO enrichment_requests(id,requested_at,window_start,reserved) VALUES(?1,?2,?3,?4)",params![id,now,start,amount]).map_err(|_| UNAVAILABLE)?;
        transaction.commit().map_err(|_| UNAVAILABLE)?;
        Ok(Reservation {
            budget: self.clone(),
            id,
            window: start,
            settled: false,
        })
    }
    fn settle(
        &self,
        id: &str,
        expected_window: i64,
        actual: Option<u64>,
        unsent: bool,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|_| UNAVAILABLE)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| UNAVAILABLE)?;
        let current_window: i64 = transaction
            .query_row(
                "SELECT window_start FROM enrichment_budget WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| UNAVAILABLE)?;
        if current_window != expected_window {
            return Ok(());
        }
        let reservation: Option<(i64, i64)> = transaction
            .query_row(
                "SELECT window_start,reserved FROM enrichment_requests WHERE id=?1 AND settled=0",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| UNAVAILABLE)?;
        let Some((window, reserved)) = reservation else {
            return Err(UNAVAILABLE.into());
        };
        let (current, used): (i64, i64) = transaction
            .query_row(
                "SELECT window_start,used FROM enrichment_budget WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| UNAVAILABLE)?;
        let mut exhausted = false;
        if current == window {
            if let Some(actual) = actual.and_then(|value| i64::try_from(value).ok()) {
                if let Some(total) = used
                    .checked_sub(reserved)
                    .and_then(|base| base.checked_add(actual))
                    .filter(|value| *value >= 0)
                {
                    transaction
                        .execute("UPDATE enrichment_budget SET used=?1 WHERE id=1", [total])
                        .map_err(|_| UNAVAILABLE)?;
                    exhausted = total > LIMIT;
                } else {
                    transaction
                        .execute("UPDATE enrichment_budget SET blocked=1 WHERE id=1", [])
                        .map_err(|_| UNAVAILABLE)?;
                    exhausted = true;
                }
            } else {
                // An unmetered/cancelled dispatched request may have spent any of the remaining quota.
                transaction
                    .execute("UPDATE enrichment_budget SET blocked=1 WHERE id=1", [])
                    .map_err(|_| UNAVAILABLE)?;
                exhausted = true;
            }
        }
        if unsent {
            transaction
                .execute("DELETE FROM enrichment_requests WHERE id=?1", [id])
                .map_err(|_| UNAVAILABLE)?;
        } else {
            transaction
                .execute("UPDATE enrichment_requests SET settled=1 WHERE id=?1", [id])
                .map_err(|_| UNAVAILABLE)?;
        }
        transaction.commit().map_err(|_| UNAVAILABLE)?;
        if exhausted {
            Err(DEFERRED.into())
        } else {
            Ok(())
        }
    }
}
impl Reservation {
    pub(crate) fn settle(&mut self, actual: Option<u64>) -> Result<(), String> {
        if self.settled {
            return Err(UNAVAILABLE.into());
        }
        let result = self.budget.settle(&self.id, self.window, actual, false);
        self.settled = true;
        if result.as_ref().is_err_and(|error| error != DEFERRED) {
            self.budget
                .unavailable
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        result
    }
    pub(crate) fn cancel_unsent(&mut self) -> Result<(), String> {
        if self.settled {
            return Err(UNAVAILABLE.into());
        }
        let result = self.budget.settle(&self.id, self.window, Some(0), true);
        self.settled = true;
        if result.is_err() {
            self.budget
                .unavailable
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        result
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.settled
            && self
                .budget
                .settle(&self.id, self.window, None, false)
                .as_ref()
                .is_err_and(|error| error != DEFERRED)
        {
            self.budget
                .unavailable
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

pub(crate) fn usage_tokens(value: &serde_json::Value) -> Option<u64> {
    let usage = value.get("usage")?;
    let input = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(|value| value.as_u64());
    let output_field = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"));
    let output = output_field.and_then(|value| value.as_u64());
    let total = usage.get("total_tokens").and_then(|value| value.as_u64());
    match (input, output, total) {
        (Some(input), Some(output), total) => input
            .checked_add(output)
            .filter(|sum| total.is_none_or(|total| total == *sum)),
        (Some(input), None, Some(total)) if output_field.is_none() && input == total => Some(total),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const DAY: i64 = 24 * 60 * 60 * 1000;
    #[test]
    fn enrichment_budget_validates_usage_and_refunds_only_proven_unsent_requests() {
        assert_eq!(
            usage_tokens(
                &serde_json::json!({"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}})
            ),
            Some(6)
        );
        assert_eq!(
            usage_tokens(&serde_json::json!({"usage":{"prompt_tokens":4,"completion_tokens":2}})),
            Some(6)
        );
        assert_eq!(
            usage_tokens(&serde_json::json!({"usage":{"prompt_tokens":4,"total_tokens":4}})),
            Some(4)
        );
        for value in [
            serde_json::json!({}),
            serde_json::json!({"usage":{"type":"duration","seconds":1}}),
            serde_json::json!({"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":7}}),
            serde_json::json!({"usage":{"input_tokens":u64::MAX,"output_tokens":2}}),
            serde_json::json!({"usage":{"input_tokens":4,"output_tokens":-1,"total_tokens":4}}),
            serde_json::json!({"usage":{"prompt_tokens":4,"completion_tokens":"bad","total_tokens":4}}),
        ] {
            assert!(usage_tokens(&value).is_none());
        }
        let (_fixture, budget) = budget();
        for _ in 0..20 {
            let mut permit = budget.reserve_at(None, 1000).unwrap();
            permit.cancel_unsent().unwrap();
        }
        let mut permit = budget.reserve_at(None, 1000).unwrap();
        permit.settle(Some(1)).unwrap();
    }
    fn budget() -> (
        crate::search::test_support::SearchFixture,
        Arc<EnrichmentBudget>,
    ) {
        let fixture = crate::search::test_support::SearchFixture::new("shared-enrichment-budget");
        let budget = EnrichmentBudget::open(&fixture.root().join("budget.sqlite")).unwrap();
        (fixture, budget)
    }
    #[test]
    fn enrichment_budget_is_shared_atomic_and_every_retry_counts() {
        let (_fixture, budget) = budget();
        let mut joins = Vec::new();
        for _ in 0..20 {
            let budget = budget.clone();
            joins.push(std::thread::spawn(move || {
                budget
                    .reserve_at(Some(1), 1000)
                    .map(|mut permit| permit.settle(Some(1)))
                    .is_ok()
            }));
        }
        assert_eq!(
            joins
                .into_iter()
                .map(|join| join.join().unwrap())
                .filter(|accepted| *accepted)
                .count(),
            10
        );
        assert!(budget.reserve_at(Some(1), 1001).is_err());
        assert!(budget.reserve_at(Some(1), 61000).is_ok());
    }
    #[test]
    fn enrichment_budget_amends_actual_usage_and_cannot_refund_twice() {
        let (_fixture, budget) = budget();
        let mut multimodal = budget.reserve_at(None, 1000).unwrap();
        assert!(budget.reserve_at(Some(1), 1001).is_err());
        multimodal.settle(Some(200000)).unwrap();
        assert!(multimodal.settle(Some(0)).is_err());
        let mut embedding = budget.reserve_at(Some(100), 1001).unwrap();
        embedding.settle(Some(200)).unwrap();
        let mut improvement = budget.reserve_at(Some(299800), 1002).unwrap();
        improvement.settle(Some(299800)).unwrap();
        assert!(budget.reserve_at(Some(1), 62000).is_err());
    }
    #[test]
    fn enrichment_budget_unknown_usage_and_cancellation_remain_blocked_after_restart() {
        for cancelled in [false, true] {
            let (fixture, budget) = budget();
            let mut reservation = budget.reserve_at(Some(1), 1000).unwrap();
            if !cancelled {
                assert!(reservation.settle(None).is_err());
            }
            drop(reservation);
            drop(budget);
            let reopened = EnrichmentBudget::open(&fixture.root().join("budget.sqlite")).unwrap();
            assert!(reopened.reserve_at(Some(1), 62000).is_err());
            let mut fresh = reopened.reserve_at(Some(1), 1000 + DAY).unwrap();
            fresh.settle(Some(1)).unwrap();
        }
    }
    #[test]
    fn enrichment_budget_crash_and_settled_usage_survive_restart_and_old_permits_cannot_refund_new_window()
     {
        let (fixture, budget) = budget();
        let mut known = budget.reserve_at(Some(100), 1000).unwrap();
        known.settle(Some(400000)).unwrap();
        drop(known);
        drop(budget);
        let reopened = EnrichmentBudget::open(&fixture.root().join("budget.sqlite")).unwrap();
        assert!(reopened.reserve_at(Some(100001), 62000).is_err());
        let old = reopened.reserve_at(Some(1), 62000).unwrap();
        // Forgetting the permit models process death before Drop can persist unknown usage.
        std::mem::forget(old);
        let recovered = EnrichmentBudget::open(&fixture.root().join("budget.sqlite")).unwrap();
        assert!(recovered.reserve_at(Some(1), 62001).is_err());
        let mut late = recovered.reserve_at(None, DAY + 1000).unwrap();
        let mut new_day = recovered.reserve_at(None, 2 * DAY + 1000).unwrap();
        late.settle(Some(0)).unwrap();
        assert!(recovered.reserve_at(Some(1), 2 * DAY + 1001).is_err());
        new_day.settle(Some(500000)).unwrap();
    }
    #[test]
    fn enrichment_budget_debt_refill_clock_reversal_and_deferral_do_not_mint_quota() {
        let (_fixture, budget) = budget();
        let mut reservation = budget.reserve_at(Some(1), 1000).unwrap();
        assert!(reservation.settle(Some(500001)).is_err());
        assert!(budget.reserve_at(Some(1), 62000).is_err());
        assert!(budget.reserve_at(Some(1), 999).is_err());
        for _ in 0..20 {
            assert!(budget.reserve_at(Some(500001), DAY + 1000).is_err());
        }
        for _ in 0..10 {
            let mut permit = budget.reserve_at(Some(1), DAY + 1000).unwrap();
            permit.settle(Some(1)).unwrap();
        }
        assert!(budget.reserve_at(Some(1), DAY + 1000).is_err());
    }
}
