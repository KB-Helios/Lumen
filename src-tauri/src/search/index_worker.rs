use std::collections::{BTreeSet, HashMap, HashSet};
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
const RECONCILE_RETRY: Duration = Duration::from_secs(5);

#[cfg(test)]
type InventoryCycleGate = Arc<dyn Fn(bool, bool) + Send + Sync>;
#[cfg(test)]
type InventoryRecordGate = Arc<dyn Fn(&Path) + Send + Sync>;

#[derive(Clone)]
pub(super) struct PendingContent {
    pub root: PathBuf,
    pub path: PathBuf,
    pub signature: String,
    pub generation: u64,
    pub admission: u64,
    pub cloud_enrichment: bool,
    pub retry_at: Instant,
    pub attempts: u32,
}

#[derive(Default)]
pub(super) struct PendingQueue {
    jobs: HashMap<String, PendingContent>,
    ordered: BTreeSet<(PathBuf, String)>,
}

impl std::ops::Deref for PendingQueue {
    type Target = HashMap<String, PendingContent>;
    fn deref(&self) -> &Self::Target {
        &self.jobs
    }
}

impl PendingQueue {
    #[cfg(test)]
    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut PendingContent> {
        self.jobs.values_mut()
    }

    pub fn insert(&mut self, id: String, item: PendingContent) {
        if let Some(previous) = self.jobs.insert(id.clone(), item.clone()) {
            self.ordered.remove(&(previous.path, id.clone()));
        }
        self.ordered.insert((item.path, id));
    }

    pub fn remove(&mut self, id: &str) -> Option<PendingContent> {
        let item = self.jobs.remove(id)?;
        self.ordered.remove(&(item.path.clone(), id.to_owned()));
        Some(item)
    }

    pub fn clear(&mut self) {
        self.jobs.clear();
        self.ordered.clear();
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&String, &PendingContent) -> bool) {
        let ordered = &mut self.ordered;
        self.jobs.retain(|id, item| {
            if keep(id, item) {
                true
            } else {
                ordered.remove(&(item.path.clone(), id.clone()));
                false
            }
        });
    }

    // Retry mutations cannot change the path used by the ordered index.
    pub fn retry(&mut self, id: &str, retry_at: Instant) {
        if let Some(item) = self.jobs.get_mut(id) {
            item.attempts = item.attempts.saturating_add(1);
            item.retry_at = retry_at;
        }
    }

    pub fn next_due(&self) -> (Option<(String, PendingContent)>, usize) {
        let now = Instant::now();
        let mut examined = 0;
        for (_, id) in &self.ordered {
            examined += 1;
            let item = &self.jobs[id];
            if item.retry_at <= now {
                return (Some((id.clone(), item.clone())), examined);
            }
        }
        (None, examined)
    }
}

#[cfg(test)]
mod pending_queue_tests {
    use super::*;

    fn item(path: &str) -> PendingContent {
        PendingContent {
            root: PathBuf::from("root"),
            path: PathBuf::from(path),
            signature: "hash".into(),
            generation: 7,
            admission: 9,
            cloud_enrichment: false,
            retry_at: Instant::now(),
            attempts: 0,
        }
    }

    #[test]
    fn ordered_pending_keeps_retry_replacement_and_removal_consistent() {
        let mut queue = PendingQueue::default();
        queue.insert("a".into(), item("a.txt"));
        queue.insert("b".into(), item("b.txt"));
        queue.retry("a", Instant::now() + Duration::from_secs(5));
        assert_eq!(queue.next_due().0.unwrap().0, "b");
        assert_eq!(queue["a"].attempts, 1);
        queue.insert("a".into(), item("c.txt"));
        assert_eq!(queue.remove("b").unwrap().path, Path::new("b.txt"));
        assert_eq!(queue.next_due().0.unwrap().1.path, Path::new("c.txt"));
        queue.insert("overlap".into(), item("c.txt"));
        queue.retain(|id, _| id == "overlap");
        assert_eq!(queue.next_due().0.unwrap().0, "overlap");
        queue.remove("overlap");
        assert!(queue.next_due().0.is_none());
        queue.insert("a".into(), item("a.txt"));
        queue.clear();
        assert_eq!(queue.next_due().1, 0);
    }
}

#[derive(Default)]
pub(super) struct WorkState {
    pub reconcile_finished: Mutex<Option<Instant>>,
    #[cfg(test)]
    pub metrics: super::indexing::capacity_tests::Metrics,
    #[cfg(test)]
    pub inventory_cycle_gate: Mutex<Option<InventoryCycleGate>>,
    #[cfg(test)]
    pub path_refresh_gate: Mutex<Option<InventoryCycleGate>>,
    #[cfg(test)]
    pub periodic_due: AtomicBool,
    #[cfg(test)]
    pub traversal_limit: AtomicU64,
    #[cfg(test)]
    pub inventory_record_gate: Mutex<Option<InventoryRecordGate>>,
    pub roots: Mutex<Vec<IndexRootRequest>>,
    pub configured: AtomicBool,
    pub pending: Mutex<PendingQueue>,
    pub completed: Mutex<HashMap<String, String>>,
    pub failed: Mutex<HashMap<String, String>>,
    pub next_admission: AtomicU64,
    pub content_enabled: AtomicBool,
    pub reconcile: AtomicBool,
    pub stop: AtomicBool,
    pub inventory_running: AtomicBool,
    pub watcher_degraded: AtomicBool,
    pub inventory_failed: AtomicBool,
    pub inventory_incomplete: AtomicBool,
}

pub(super) struct ReconcileClock<'a>(pub &'a Mutex<Option<Instant>>);

impl Drop for ReconcileClock<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = Some(Instant::now());
    }
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
                // Amortize the measured per-document polling delay, retaining bounded rests.
                for _ in 0..8 {
                    if runtime.work.stop.load(Ordering::SeqCst)
                        || !runtime.work.content_enabled.load(Ordering::SeqCst)
                        || runtime.work.inventory_running.load(Ordering::SeqCst)
                    {
                        break;
                    }
                    match runtime.extract_pending() {
                        Ok(true) => {}
                        Ok(false) => break,
                        Err(error) => {
                            runtime.worker_failed(&error.message);
                            break;
                        }
                    }
                }
                #[cfg(test)]
                let sleep_clock = Instant::now();
                std::thread::sleep(Duration::from_millis(25));
                #[cfg(test)]
                runtime.work.metrics.sleep(sleep_clock.elapsed());
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
    let started = Instant::now();
    let mut retry_at = None;
    let mut forced_retry = false;
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
        // Defaults are not an authoritative empty policy; retain all queued obligations.
        if !runtime.work.configured.load(Ordering::SeqCst)
            || runtime.work.stop.load(Ordering::SeqCst)
        {
            #[cfg(test)]
            let cycle_gate = runtime.work.inventory_cycle_gate.lock().unwrap().clone();
            #[cfg(test)]
            if let Some(gate) = cycle_gate {
                gate(!dirty.is_empty(), false);
            }
            continue;
        }
        let last_reconcile = runtime
            .work
            .reconcile_finished
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .unwrap_or(started);
        let periodic_reconcile = last_reconcile.elapsed() >= RECONCILE_INTERVAL;
        #[cfg(test)]
        let periodic_reconcile =
            periodic_reconcile || runtime.work.periodic_due.swap(false, Ordering::SeqCst);
        let missed_events = overflow.swap(false, Ordering::SeqCst);
        forced_retry |= missed_events;
        let reconcile = runtime.work.reconcile.swap(false, Ordering::SeqCst)
            || missed_events
            || periodic_reconcile
            || retry_at.is_some_and(|deadline| Instant::now() >= deadline);
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
            let result = runtime.reconcile_inventory(forced_retry);
            runtime
                .work
                .inventory_running
                .store(false, Ordering::SeqCst);
            match result {
                Err(error) => {
                    retry_at = Some(Instant::now() + RECONCILE_RETRY);
                    runtime.work.inventory_failed.store(true, Ordering::SeqCst);
                    runtime.worker_failed(&error.message);
                }
                Ok(false) => {
                    runtime.work.reconcile.store(true, Ordering::SeqCst);
                }
                Ok(true)
                    if runtime.work.inventory_incomplete.load(Ordering::SeqCst) && forced_retry =>
                {
                    // A partial traversal cannot establish content freshness.
                    retry_at = Some(Instant::now() + RECONCILE_RETRY);
                }
                Ok(true) => {
                    forced_retry = false;
                    retry_at = None;
                }
            }
            if missed_events {
                dirty.clear();
            }
        }
        // Metadata reconciliation does not establish content freshness for delivered events.
        if !dirty.is_empty() && (reconcile || Instant::now() >= due) {
            runtime.work.inventory_running.store(true, Ordering::SeqCst);
            let result = runtime.refresh_paths(dirty.iter().cloned().collect());
            runtime
                .work
                .inventory_running
                .store(false, Ordering::SeqCst);
            match result {
                Ok(true) => dirty.clear(),
                Ok(false) => {}
                Err(error) => {
                    dirty.clear();
                    // Failed dirty writes still owe a freshness reconciliation.
                    forced_retry = true;
                    retry_at = Some(Instant::now() + RECONCILE_RETRY);
                    runtime.work.inventory_failed.store(true, Ordering::SeqCst);
                    runtime.worker_failed(&error.message);
                }
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

/// Maps watcher spelling beneath the admitted root, trying safe Windows short-name expansion if needed.
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
    /// Matches path components case-insensitively while preserving suffix spelling and rejecting parent traversal.
    fn admitted_path(root: &Path, path: &Path) -> Option<PathBuf> {
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
    if let Some(admitted) = admitted_path(root, path) {
        return Some(admitted);
    }
    #[cfg(windows)]
    if let Some(expanded) = expand_windows_event_spelling(path) {
        return admitted_path(root, &expanded);
    }
    None
}

#[cfg(windows)]
/// Expands an existing Windows ancestor to its long spelling and preserves any missing suffix.
/// Rejects relative paths, parent traversal, reparse ancestors, and incomplete ancestor inspection.
fn expand_windows_event_spelling(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_REPARSE_POINT, GetLongPathNameW};
    use windows::core::PCWSTR;

    if !path.is_absolute()
        || path
            .to_string_lossy()
            .replace('\\', "/")
            .split('/')
            .any(|part| part == "..")
    {
        return None;
    }
    let mut existing = None;
    let mut reached_root = false;
    // Expand only spelling; never canonicalize an event through a reparse route.
    for ancestor in path.ancestors().take(256) {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
                    return None;
                }
                existing.get_or_insert(ancestor);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        reached_root |= ancestor.parent().is_none();
    }
    if !reached_root {
        return None;
    }
    let existing = existing?;
    let input: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut output = vec![0u16; 32_768];
    let length = unsafe { GetLongPathNameW(PCWSTR(input.as_ptr()), Some(&mut output)) } as usize;
    if length == 0 || length >= output.len() {
        return None;
    }
    let expanded = PathBuf::from(std::ffi::OsString::from_wide(&output[..length]));
    Some(expanded.join(path.strip_prefix(existing).ok()?))
}
