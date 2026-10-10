import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {URLSearchParams} from 'node:url';
import {chromium} from '@playwright/test';

import {createAnswerNativeBridge} from './lib/answer-native-bridge.mjs';
import {finishNativeAnswerProcess} from './lib/answer-native-shutdown.mjs';
import {withLumenDevServer} from './lib/lumen-dev-server.mjs';

const nativeTest = 'gateway::answer::transport_tests::native_bridge';
const binaryDirectory = path.join(process.env.CARGO_TARGET_DIR ?? path.resolve('src-tauri/target'), 'debug', 'deps');
const execFileAsync = promisify(execFile);

async function nativeBinary() {
  if (process.env.LUMEN_ANSWER_NATIVE_BINARY) {
    const binary = path.resolve(process.env.LUMEN_ANSWER_NATIVE_BINARY);
    assert.match(path.basename(binary), /^lumen_lib-[a-f\d]+\.exe$/i);
    assert.equal((await stat(binary)).isFile(), true);
    return binary;
  }
  const files = (await readdir(binaryDirectory)).filter((file) => /^lumen_lib-[a-f\d]+\.exe$/i.test(file));
  assert.equal(files.length, 1, 'Set LUMEN_ANSWER_NATIVE_BINARY when native test binaries are ambiguous.');
  return path.join(binaryDirectory, files[0]);
}

async function residentBytes(pid) {
  assert.equal(Number.isSafeInteger(pid), true);
  const {stdout} = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], {windowsHide: true});
  const bytes = Number(stdout.trim());
  assert.equal(Number.isFinite(bytes), true);
  return bytes;
}

async function run(url) {
  const binary = await nativeBinary();
  const native = spawn(binary, ['--exact', nativeTest, '--ignored', '--nocapture', '--test-threads=1'], {
    cwd: process.cwd(), env: {...process.env, LUMEN_ANSWER_BRIDGE: '1'}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let bridge;
  let browser;
  let report;
  const failures = [];
  try {
    let processFailure;
    native.on('error', (error) => { processFailure = error; });
    native.stdin.on('error', (error) => { processFailure = error; });
    native.stderr.on('data', () => undefined);
    bridge = await createAnswerNativeBridge(native);
    browser = await chromium.launch({channel: 'msedge'});
    const page = await browser.newPage({viewport: {width: 900, height: 600}});
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    report = {recordedAt: new Date().toISOString(), browserVersion: browser.version(), evidence: 'loopback-native-transport-installed-edge', binary: path.basename(binary), nativeTest,
      packagedWebViewVerified: false, liveProviderVerified: false,
      obsoleteUsagePrecondition: 'test-only metadata injection; production transport emits completed usage',
      scenarios: {}, nativeMemory: {samplesBytes: []}};
    assert.equal(path.isAbsolute(report.binary), false, 'Published answer evidence must not expose absolute host paths.');
    assert.doesNotMatch(report.binary, /[/\\]/, 'Published answer evidence must contain only the binary filename.');
    const state = () => page.evaluate(() => window.__LUMEN_ANSWER_HARNESS__.state);
    const metrics = () => page.evaluate(() => ({...window.__LUMEN_ANSWER_HARNESS__.metrics, snapshots: undefined}));
    const submit = async (query, mode = 'auto') => {
      if (processFailure) throw processFailure;
      assert.equal(native.exitCode, null, 'Native bridge exited before submission.');
      const previousId = bridge.samples.at(-1)?.requestId;
      await page.evaluate(({query, mode}) => window.__LUMEN_ANSWER_HARNESS__.submit(query, mode), {query, mode});
      for (let attempt = 0; attempt < 200 && bridge.samples.at(-1)?.requestId === previousId; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.notEqual(bridge.samples.at(-1)?.requestId, previousId, 'Submission did not reach native transport.');
    };
    const phase = async (expected) => page.waitForFunction((expected) => window.__LUMEN_ANSWER_HARNESS__?.state.phase === expected, expected, {timeout: 15_000});
    const drained = async () => {
      for (let attempt = 0; attempt < 100 && bridge.activeRequests; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(bridge.activeRequests, 0, 'Native bridge retained a completed request.');
    };
    await page.goto(`${url}/tests/answer-native.html?${new URLSearchParams({bridge: bridge.url, token: bridge.token})}`);
    await page.waitForFunction(() => !!window.__LUMEN_ANSWER_HARNESS__);
    await submit('fallback');
    await phase('completed');
    const fallback = await state();
    assert.equal(fallback.text, 'Local fixture answer 🌍');
    assert.equal(fallback.provider, 'local-fixture');
    assert.equal(fallback.model, 'fixture-model');
    assert.equal(fallback.route, 'lumen.answer.local');
    assert.equal(fallback.usage, undefined);
    assert.deepEqual(fallback.citations, [{fileId: 'fixture-source', label: 'Fixture source', page: 2}]);
    await page.getByTestId('answer-region').waitFor();
    assert.equal(await page.getByTestId('answer-region').innerText(), 'Local fixture answer 🌍');
    assert.equal(await page.getByRole('button', {name: 'Open Fixture source, page 2'}).count(), 1);
    report.scenarios.fallback = await metrics();
    await drained();

    await submit('retry');
    await page.getByTestId('answer-region').filter({hasText: 'Partial stalled answer'}).waitFor();
    const stopAt = performance.now();
    await page.getByRole('button', {name: 'Stop answer'}).click();
    await phase('cancelled');
    report.scenarios.stop = {uiStopMs: performance.now() - stopAt};
    assert.ok(report.scenarios.stop.uiStopMs < 250, 'Rendered Stop took longer than 250 ms.');
    await drained();
    await page.getByRole('button', {name: 'Retry answer'}).click();
    await phase('completed');
    assert.equal((await state()).text, 'Retry fixture answer');
    await drained();

    await submit('replacement-a');
    await page.getByTestId('answer-region').filter({hasText: 'Partial stalled answer'}).waitFor();
    await submit('replacement-b');
    await phase('completed');
    assert.equal((await state()).text, 'Replacement fixture answer');
    report.scenarios.replacement = await metrics();
    await drained();

    await submit('burst', 'local');
    await phase('completed');
    assert.equal((await state()).text, 'x'.repeat(1000));
    assert.equal(await page.getByTestId('answer-region').innerText(), 'x'.repeat(1000));
    report.scenarios.burst = await metrics();
    await drained();

    await submit('delivery-order', 'local');
    await phase('completed');
    const delayedText = `Delayed channel fixture 🌍${'x'.repeat(16_384)}`;
    assert.equal((await state()).text, delayedText);
    assert.equal(await page.getByTestId('answer-region').innerText(), delayedText);
    report.scenarios.deliveryOrder = await metrics();
    await drained();

    // Warm the same native process before measuring repeated failures.
    for (let index = 0; index < 35; index++) {
      await submit('failure', 'local');
      await phase('error');
      await drained();
      assert.equal((await state()).text, '');
      if (index >= 5 && index % 5 === 0) report.nativeMemory.samplesBytes.push(await residentBytes(native.pid));
    }
    report.nativeMemory.iterations = 35;
    report.nativeMemory.firstToLastGrowthBytes = report.nativeMemory.samplesBytes.at(-1) - report.nativeMemory.samplesBytes[0];
    report.nativeSamples = bridge.samples.map((sample) => ({requestId: sample.requestId, query: sample.query,
      events: sample.events, attempts: sample.attempts, firstTokenMs: sample.firstTokenMs,
      doneMs: sample.doneMs, cancelToNativeDoneMs: sample.cancelToNativeDoneMs}));
    const cancelled = report.nativeSamples.filter((sample) => sample.cancelToNativeDoneMs !== undefined);
    assert.equal(cancelled.length >= 2, true, 'Stop and replacement must reach native cancellation.');
    for (const sample of cancelled) assert.ok(sample.cancelToNativeDoneMs < 250, `Native cancellation took ${sample.cancelToNativeDoneMs} ms.`);
    assert.deepEqual(errors, []);
  } catch (error) {
    failures.push(error);
  } finally {
    try { await browser?.close(); } catch (error) { failures.push(error); }
    try { await bridge?.close(); } catch (error) { failures.push(error); }
    try {
      const shutdown = await finishNativeAnswerProcess(native);
      if (report) report.nativeShutdown = shutdown;
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Native answer integration or cleanup failed.');
  const output = path.resolve('artifacts/performance/answer-native-integration.json');
  await mkdir(path.dirname(output), {recursive: true});
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Native answer integration passed. Evidence: ${output}\n`);
}

await withLumenDevServer(run);
