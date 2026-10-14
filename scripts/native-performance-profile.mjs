import {execFileSync, spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {withLumenDevServer} from './lib/lumen-dev-server.mjs';
import {sampleFrameCadence} from '../src/features/diagnostics/diagnostics.refresh.mjs';

// Run via bun run node with LUMEN_NATIVE_PERFORMANCE_EXE set to an owned debug
// build, and optional LUMEN_PROFILE_OUTPUT_DIR. Never launches ordinary Lumen.
const fixtureUrl = 'http://localhost:1420/scripts/native-performance.html';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? null;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function admitFixturePage(page) {
  if (page.url() !== fixtureUrl) throw new Error('Expected the isolated fixture URL');
  if (await page.evaluate(() => window.__LUMEN_NATIVE_PERFORMANCE__ === true) !== true) throw new Error('Missing native marker');
}

export function ownedDescendants(processes, rootPid) {
  const owned = new Set([rootPid]);
  let changed;
  do {
    changed = false;
    for (const process of processes) {
      if (owned.has(process.ParentProcessId) && !owned.has(process.ProcessId)) {
        owned.add(process.ProcessId);
        changed = true;
      }
    }
  } while (changed);
  return owned;
}

function powershell(source) {
  return execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'; ${source}`, 'utf16le').toString('base64')], {encoding: 'utf8', windowsHide: true}).trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForEndpoint(port, child) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Fixture exited ${child.exitCode} before CDP readiness`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(500)});
      if (response.ok) return await response.json();
    } catch { /* The owned WebView is still starting. */ }
    await delay(200);
  }
  throw new Error('Owned WebView2 CDP readiness timed out');
}

async function measure(page, output) {
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await search.waitFor({state: 'visible'});
  await search.fill('report');
  await page.getByRole('grid', {name: 'Search results'}).waitFor();
  const reset = () => page.evaluate(() => window.__LUMEN_DIAGNOSTICS__.reset());
  const read = () => page.evaluate(() => window.__LUMEN_DIAGNOSTICS__.read());
  const wait = (name, count) => page.waitForFunction(({name, count}) => window.__LUMEN_DIAGNOSTICS__.read().timings.filter((sample) => sample.name === name).length >= count, {name, count});
  const status = () => page.evaluate(async () => (await import('/node_modules/@tauri-apps/api/core.js')).invoke('native_performance_status'));
  const before = await status();
  if (before.fixture !== 'offline-ui-memory' || !before.foregroundUnchanged || !before.visible) throw new Error(`Native fixture visibility/foreground admission failed: ${JSON.stringify(before)}`);
  const display = await page.evaluate(() => ({width: window.innerWidth, height: window.innerHeight, screenWidth: window.screen.width, screenHeight: window.screen.height, devicePixelRatio: window.devicePixelRatio, visibility: document.visibilityState, userAgent: window.navigator.userAgent}));
  const cadence = await page.evaluate(sampleFrameCadence);
  for (let index = 0; index < 10; index += 1) { await search.fill(`warm-input-${index}`); await page.waitForTimeout(8); }
  await search.fill(''); await page.waitForTimeout(50); await reset();
  for (let index = 1; index <= 30; index += 1) {
    await search.fill(`report-${index}`); await wait('input-response', index); await wait('input-next-frame', index); await page.waitForTimeout(40);
  }
  const input = await read();
  const queries = ['report', 'design', 'project', ''];
  const ordinary = {reactCommits: [], browserLongTasks: [], commitCounts: []};
  for (let index = 0; index < 24; index += 1) {
    await reset(); await search.fill(queries[index % queries.length]); await page.waitForTimeout(250);
    const metrics = await read();
    ordinary.reactCommits.push(...metrics.reactCommits); ordinary.browserLongTasks.push(...metrics.browserLongTasks); ordinary.commitCounts.push(metrics.reactCommits.length);
  }
  await search.fill('report'); await page.getByRole('row').first().waitFor();
  for (let index = 0; index < 12; index += 1) { await page.keyboard.press(index % 2 === 0 ? 'ArrowDown' : 'ArrowUp'); await page.waitForTimeout(12); }
  await page.waitForTimeout(100); await reset();
  for (let index = 1; index <= 120; index += 1) { await page.keyboard.press(index % 2 === 0 ? 'ArrowUp' : 'ArrowDown'); await page.waitForTimeout(12); }
  await wait('selection-paint', 120); await page.waitForTimeout(80);
  const selection = await read();
  const after = await status();
  await writeFile(path.join(output, 'timed-samples.json'), JSON.stringify({display, before, after, cadence, input, ordinary, selection}, null, 2));
  const reversals = [];
  const readInput = () => search.evaluate((input) => ({value: input.value, start: input.selectionStart, end: input.selectionEnd}));
  for (let index = 0; index < 3; index += 1) {
    const inputBefore = await readInput();
    await page.evaluate(async () => {
      const {createWindowService} = await import('/src/platform/window/tauri-window-service.ts');
      const {requestWindowHide} = await import('/src/features/launcher/useLauncherPresentation.ts');
      if (!await requestWindowHide(createWindowService())) throw new Error('Typed native hide failed');
    });
    await page.locator('[data-launcher-visible="false"]').waitFor({state: 'attached'});
    const hidden = await status();
    const inputHidden = await readInput();
    if (hidden.visible || inputHidden.value !== inputBefore.value || inputHidden.start !== inputBefore.start || inputHidden.end !== inputBefore.end) throw new Error('Native hide/query/caret verification failed');
    await page.evaluate(() => window.dispatchEvent(new window.CustomEvent('lumen:diagnostics-show-launcher')));
    await page.locator('[data-launcher-visible="true"]').waitFor();
    await search.waitFor({state: 'visible'});
    await page.waitForTimeout(500);
    const shown = await status();
    reversals.push({hidden, shown, inputBefore, inputHidden, inputShown: await readInput()});
  }
  const samples = (metrics, name) => metrics.timings.filter((sample) => sample.name === name).map((sample) => sample.durationMs);
  const inputSamples = samples(input, 'input-response'); const inputFrameSamples = samples(input, 'input-next-frame'); const selectionSamples = samples(selection, 'selection-paint');
  const measured = {ordinaryReactCommitP95Ms: percentile(ordinary.reactCommits), ordinaryReactCommitSamples: ordinary.reactCommits.length, ordinaryBrowserLongTasksOver50Ms: ordinary.browserLongTasks, inputResponseP95Ms: percentile(inputSamples), inputToNextFrameP95Ms: percentile(inputFrameSamples), selectionToCallbackP95Ms: percentile(selectionSamples), selectionReactCommitP95Ms: percentile(selection.reactCommits), cadenceP95Ms: cadence.p95Ms};
  const frameBudgetMs = 1000 / 240;
  const checks = {foregroundUnchanged: before.foregroundUnchanged && after.foregroundUnchanged && reversals.every(({hidden, shown}) => hidden.foregroundUnchanged && shown.foregroundUnchanged), visible: before.visible && after.visible && display.visibility === 'visible', reversals: reversals.every(({hidden, shown, inputBefore, inputShown}) => !hidden.visible && shown.visible && inputShown.value === 'report' && inputShown.start === inputBefore.start && inputShown.end === inputBefore.end), ordinaryReactCommit: ordinary.reactCommits.length > 0 && measured.ordinaryReactCommitP95Ms < 3, ordinaryLongTasks: measured.ordinaryBrowserLongTasksOver50Ms.length === 0, inputSamples: inputSamples.length === 30 && inputFrameSamples.length === 30, selectionSamples: selectionSamples.length === 120};
  const strict240Hz = {scope: 'Captured query/input/selection subset; full native acceptance is unmeasured', fullGateMeasured: false, frameBudgetMs, cadence: cadence.intervals.length === 60 && cadence.p95Ms <= frameBudgetMs, input: measured.inputResponseP95Ms < frameBudgetMs && measured.inputToNextFrameP95Ms < frameBudgetMs, selection: measured.selectionToCallbackP95Ms < frameBudgetMs};
  strict240Hz.passed = Object.values(checks).every(Boolean) && strict240Hz.cadence && strict240Hz.input && strict240Hz.selection;
  return {display, before, after, reversals, measured, checks, strict240Hz, captureValid: checks.foregroundUnchanged && checks.visible && checks.reversals && checks.inputSamples && checks.selectionSamples, samples: {cadence, input, ordinary, selection}, boundary: 'Debug offline native UI fixture with existing StrictMode/AppProviders/Catalogue memory search; no ordinary startup, index, credentials or providers. Exact existing 24 queries/250 ms and 12 warm plus 120 paced selections/12 ms; raw commits and long tasks retained. Input has 30 samples/40 ms. rAF callbacks precede compositor presentation. Physical mode is unchanged. Occlusion/presentation is unverified; this subset does not cover the browser gallery hover, rapid bursts, idle or complete native production runtime gates.'};
}

export async function main() {
  if (process.platform !== 'win32') throw new Error('Native fixture requires Windows');
  const executable = process.env.LUMEN_NATIVE_PERFORMANCE_EXE;
  if (!executable || !path.isAbsolute(executable)) throw new Error('Set LUMEN_NATIVE_PERFORMANCE_EXE to an owned Windows debug executable');
  const bytes = await readFile(executable);
  try { const response = await fetch('http://127.0.0.1:1420', {signal: AbortSignal.timeout(500)}); if (response.ok) throw new Error('Port 1420 already has a server; refuse unrelated source reuse'); } catch (error) { if (error.message.includes('refuse')) throw error; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'lumen-native-performance-'));
  const output = path.resolve(process.env.LUMEN_PROFILE_OUTPUT_DIR ?? 'artifacts/performance/native');
  await mkdir(output, {recursive: true});
  const sourceFiles = ['scripts/native-performance-profile.mjs', 'scripts/native-performance.html', 'src-tauri/src/lib.rs', 'src-tauri/src/window.rs', 'src-tauri/src/native_performance.rs', 'src-tauri/src/native_performance_root.rs', 'src/test/NativePerformanceFixture.tsx', 'src/test/native-performance.tsx', 'src/features/launcher/ContextActions.tsx', 'src/features/launcher/ScopeRail.tsx', 'src/features/launcher/semantic-search-context.ts', 'src/services/search/semantic-search-service.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, hash(await readFile(file))])));
  const provenance = {generatedAt: new Date().toISOString(), executable, executableSha256: hash(bytes), gitSha: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim(), trackedDiffSha256: hash(execFileSync('git', ['diff', 'HEAD'])), sourceHashes, root, physicalDisplays: JSON.parse(powershell('Get-CimInstance Win32_VideoController | Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate,DriverVersion | ConvertTo-Json'))};
  await writeFile(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
  await withLumenDevServer(async () => {
    const port = await freePort();
    const child = spawn(executable, [], {env: {...process.env, LUMEN_NATIVE_PERFORMANCE_ROOT: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let log = ''; child.stdout.on('data', (bytes) => { log += bytes; }); child.stderr.on('data', (bytes) => { log += bytes; });
    let browser;
    try {
      const version = await waitForEndpoint(port, child);
      const processes = JSON.parse(powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json'));
      const owned = ownedDescendants(processes, child.pid);
      const ownedProcesses = JSON.parse(powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${[...owned].join(',')}) } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json`));
      const listener = Number(powershell(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess`));
      if (!owned.has(listener)) throw new Error('CDP listener is not owned by the fixture executable');
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const pages = browser.contexts().flatMap((context) => context.pages());
      if (pages.length !== 1) throw new Error('Expected one isolated WebView page');
      const page = pages[0]; await page.waitForURL(fixtureUrl); await admitFixturePage(page);
      await writeFile(path.join(output, 'attachment.json'), JSON.stringify({version, rootPid: child.pid, listenerPid: listener, ownedProcesses}, null, 2));
      const result = await measure(page, output);
      await writeFile(path.join(output, 'native-profile-summary.json'), JSON.stringify({...provenance, version, rootPid: child.pid, listenerPid: listener, ownedProcesses, ...result}, null, 2));
      process.stdout.write(`${JSON.stringify(result.measured)}\n${JSON.stringify(result.checks)}\n${output}\n`);
      if (!result.captureValid || !result.strict240Hz.passed) process.exitCode = 1;
    } catch (error) {
      await writeFile(path.join(output, 'failure.json'), JSON.stringify({message: error.message, stack: error.stack}, null, 2));
      throw error;
    } finally {
      try { await browser?.close(); } finally {
        if (child.exitCode === null && child.signalCode === null) {
          // Only the exact process tree launched above; never kill by executable name.
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true});
        }
        await writeFile(path.join(output, 'fixture.log'), log);
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
