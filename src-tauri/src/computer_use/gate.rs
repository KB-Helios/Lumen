use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Admission never waits for an action; native Stop only touches atomics.
pub struct InputGate {
    generation: AtomicU64,
    busy: AtomicBool,
}

pub struct ActionPermit<'a>(&'a InputGate);

impl InputGate {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(1),
            busy: AtomicBool::new(false),
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
    pub fn is_open(&self, generation: u64) -> bool {
        generation == 1 && self.generation() == generation
    }
    pub fn admit(&self, generation: u64) -> Result<ActionPermit<'_>, &'static str> {
        if !self.is_open(generation) {
            return Err("stale_generation");
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("input_busy");
        }
        if !self.is_open(generation) {
            self.busy.store(false, Ordering::Release);
            return Err("stale_generation");
        }
        Ok(ActionPermit(self))
    }
    pub fn close(&self) -> u64 {
        self.generation.fetch_max(2, Ordering::AcqRel).max(2)
    }
}

impl Drop for ActionPermit<'_> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_fences_a_held_action_without_waiting_for_its_lock() {
        let gate = InputGate::new();
        let old = gate.generation();
        let _held = gate.admit(old).unwrap();
        let start = std::time::Instant::now();
        assert_eq!(gate.close(), old + 1);
        assert!(start.elapsed() < std::time::Duration::from_millis(50));
        assert!(!gate.is_open(old));
    }
    #[test]
    fn admission_is_serial_and_stop_is_idempotent() {
        let gate = InputGate::new();
        let permit = gate.admit(1).unwrap();
        assert!(gate.admit(1).is_err());
        drop(permit);
        assert!(gate.admit(1).is_ok());
        let stopped = gate.close();
        assert_eq!(gate.close(), stopped);
        assert!(gate.admit(stopped).is_err());
        assert!(gate.admit(1).is_err());
    }
}
