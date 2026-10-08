use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::indexing::{IndexRootRequest, IndexRuntime};

pub(super) const QUEUE_CAPACITY: usize = 256;
const MAX_DIRTY_PATHS: usize = 1024;
const DEBOUNCE: Duration = Duration::from_millis(150);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(30);

#[cfg(test)]
type InventoryCycleGate = Arc<dyn Fn(bool, bool) + Send + Sync>;

#[derive(Clone)]
pub(super) struct PendingContent {
    pub root: PathBuf,
    pub path: PathBuf,
    pub signature: String,
    pub generation: u64,
    pub admission: u64,
    pub cloud_enrichment: bool,
    pub retry_at: Instant,
}

#[derive(Default)]
pub(super) struct WorkState {
    #[cfg(test)]
    pub inventory_cycle_gate: Mutex<Option<InventoryCycleGate>>,
    #[cfg(test)]
    pub periodic_due: AtomicBool,
    pub roots: Mutex<Vec<IndexRootRequest>>,
    pub configured: AtomicBool,
    pub pending: Mutex<HashMap<String, PendingContent>>,
    pub completed: Mutex<HashMap<String, String>>,
    pub next_admission: AtomicU64,
    pub content_enabled: AtomicBool,
    pub reconcile: AtomicBool,
    pub stop: AtomicBool,
    pub inventory_running: AtomicBool,
    pub watcher_degraded: AtomicBool,
    pub inventory_failed: AtomicBool,
}

pub(super) struct IndexWorker {
    sender: mpsc::SyncSender<Vec<PathBuf>>,
    overflow: Arc<AtomicBool>,
    work: Arc<WorkState>,
    threads: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

impl Drop for IndexWorker {
    fn drop(&mut self) {
        self.work.stop.store(true, Ordering::SeqCst);
        let _ = self.sender.try_send(Vec::new());
        for thread in self
            .threads
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            let _ = thread.join();
        }
    }
}

impl IndexWorker {
    pub fn start(runtime: IndexRuntime) -> Arc<Self> {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let overflow = Arc::new(AtomicBool::new(false));
        let worker = Arc::new(Self {
            sender,
            overflow,
            work: runtime.work.clone(),
            threads: Mutex::new(Vec::new()),
        });
        let inventory_runtime = runtime.clone();
        let callback_sender = worker.sender.clone();
        let overflow = worker.overflow.clone();
        let inventory_thread = std::thread::spawn(move || {
            inventory_loop(inventory_runtime, receiver, callback_sender, overflow)
        });
        let content_thread = std::thread::spawn(move || {
            while !runtime.work.stop.load(Ordering::SeqCst) {
                if runtime.work.content_enabled.load(Ordering::SeqCst)
                    && !runtime.work.inventory_running.load(Ordering::SeqCst)
                    && let Err(error) = runtime.extract_pending()
                {
                    runtime.worker_failed(&error.message);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        });
        worker
            .threads
            .lock()
            .unwrap()
            .extend([inventory_thread, content_thread]);
        worker
    }

    pub fn wake(&self) {
        let _ = self.sender.try_send(Vec::new());
    }

    pub fn stop(&self) {
        self.work.stop.store(true, Ordering::SeqCst);
        self.wake();
    }

    #[cfg(test)]
    pub fn overflow_for_test(&self) -> usize {
        let mut dropped = 0;
        // Empty notifications exercise the actual bounded channel without adding dirty paths.
        for _ in 0..QUEUE_CAPACITY * 4 {
            if self.sender.try_send(Vec::new()).is_err() {
                dropped += 1;
                self.overflow.store(true, Ordering::SeqCst);
            }
        }
        self.wake();
        dropped
    }
}

fn inventory_loop(
    runtime: IndexRuntime,
    receiver: mpsc::Receiver<Vec<PathBuf>>,
    sender: mpsc::SyncSender<Vec<PathBuf>>,
    overflow: Arc<AtomicBool>,
) {
    let callback_overflow = overflow.clone();
    let callback_work = runtime.work.clone();
    let watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| match result {
            Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                callback_overflow.fetch_or(
                    event.need_rescan()
                        || event.paths.len() > MAX_DIRTY_PATHS
                        || sender.try_send(event.paths).is_err(),
                    Ordering::SeqCst,
                );
            }
            Err(_) => {
                callback_work.watcher_degraded.store(true, Ordering::SeqCst);
                callback_overflow.store(true, Ordering::SeqCst);
            }
            _ => {}
        },
        Config::default().with_follow_symlinks(false),
    );
    let mut watcher = watcher.ok();
    let mut watched = Vec::<PathBuf>::new();
    let mut dirty = HashSet::new();
    let mut due = Instant::now();
    let mut last_reconcile = Instant::now();
    while !runtime.work.stop.load(Ordering::SeqCst) {
        if let Ok(paths) = receiver.recv_timeout(Duration::from_millis(50)) {
            if dirty.is_empty() {
                due = Instant::now() + DEBOUNCE;
            }
            dirty.extend(paths.into_iter().take(MAX_DIRTY_PATHS));
            if dirty.len() >= MAX_DIRTY_PATHS {
                overflow.store(true, Ordering::SeqCst);
                dirty.clear();
            }
        }
        #[cfg(test)]
        let cycle_gate = runtime.work.inventory_cycle_gate.lock().unwrap().clone();
        #[cfg(test)]
        if let Some(gate) = cycle_gate {
            gate(!dirty.is_empty(), true);
        }
        let periodic_reconcile = last_reconcile.elapsed() >= RECONCILE_INTERVAL;
        #[cfg(test)]
        let periodic_reconcile =
            periodic_reconcile || runtime.work.periodic_due.swap(false, Ordering::SeqCst);
        let missed_events = overflow.swap(false, Ordering::SeqCst);
        let reconcile = runtime.work.reconcile.swap(false, Ordering::SeqCst)
            || missed_events
            || periodic_reconcile;
        if reconcile {
            let roots = runtime
                .work
                .roots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let requested = roots
                .iter()
                .map(|root| PathBuf::from(&root.path))
                .collect::<Vec<_>>();
            let mut degraded = watcher.is_none();
            if requested != watched {
                if let Some(watcher) = watcher.as_mut() {
                    for root in &watched {
                        let _ = watcher.unwatch(root);
                    }
                    for root in &requested {
                        if watcher.watch(root, RecursiveMode::Recursive).is_err() {
                            degraded = true;
                        }
                    }
                }
                watched = requested;
            } else {
                degraded |= runtime.work.watcher_degraded.load(Ordering::SeqCst);
            }
            runtime
                .work
                .watcher_degraded
                .store(degraded, Ordering::SeqCst);
            runtime.work.inventory_running.store(true, Ordering::SeqCst);
            let result = runtime.reconcile_inventory(missed_events);
            runtime
                .work
                .inventory_running
                .store(false, Ordering::SeqCst);
            if let Err(error) = result {
                runtime.work.inventory_failed.store(true, Ordering::SeqCst);
                runtime.worker_failed(&error.message);
            }
            if missed_events {
                dirty.clear();
            }
            last_reconcile = Instant::now();
        }
        // Metadata reconciliation does not establish content freshness for delivered events.
        if !dirty.is_empty() && (reconcile || Instant::now() >= due) {
            runtime.work.inventory_running.store(true, Ordering::SeqCst);
            let result = runtime.refresh_paths(dirty.drain().collect());
            runtime
                .work
                .inventory_running
                .store(false, Ordering::SeqCst);
            if let Err(error) = result {
                runtime.work.inventory_failed.store(true, Ordering::SeqCst);
                runtime.worker_failed(&error.message);
            }
        }
        #[cfg(test)]
        let cycle_gate = runtime.work.inventory_cycle_gate.lock().unwrap().clone();
        #[cfg(test)]
        if let Some(gate) = cycle_gate {
            gate(!dirty.is_empty(), false);
        }
    }
    // Dropping the owned watcher closes OS subscriptions, including all removed roots.
    drop(watcher);
}

pub(super) fn event_path(root: &Path, path: &Path) -> Option<PathBuf> {
    fn plain(path: &Path) -> String {
        let value = path.to_string_lossy().replace('\\', "/");
        let value = if let Some(unc) = value.strip_prefix("//?/UNC/") {
            format!("//{unc}")
        } else {
            value.strip_prefix("//?/").unwrap_or(&value).to_owned()
        };
        value.trim_end_matches('/').to_owned()
    }
    let original = plain(path);
    let root_original = plain(root);
    let root_plain = root_original.to_lowercase();
    let path_plain = original.to_lowercase();
    if path_plain == root_plain {
        return Some(root.to_path_buf());
    }
    path_plain.strip_prefix(&(root_plain + "/"))?;
    // Preserve Unicode and case without slicing by a case-folded byte count.
    let suffix = original
        .split('/')
        .skip(root_original.split('/').count())
        .collect::<Vec<_>>()
        .join("/");
    if suffix.split('/').any(|part| part == "..") {
        return None;
    }
    Some(root.join(suffix))
}
