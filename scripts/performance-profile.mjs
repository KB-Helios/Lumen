import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {chromium} from 'playwright';

import {withLumenPerformanceServer} from './lib/lumen-performance-server.mjs';
import {installReactRendererProbe, readReactRenderers} from './lib/react-renderer-probe.mjs';
import {sampleHover} from './lib/hover-sample.mjs';
import {sampleFrameCadence} from '../src/features/diagnostics/diagnostics.refresh.mjs';
import {evaluateRefreshTarget} from './lib/refresh-budget.mjs';

const outputDirectory = path.resolve(process.env.LUMEN_PROFILE_OUTPUT_DIR ?? 'artifacts/performance');
const tracePath = path.join(outputDirectory, 'interaction-trace.zip');
const summaryPath = path.join(outputDirectory, 'profile-summary.json');
const targetFrameBudgetMs = 1000 / 240;
const frameSchedulingToleranceMs = 2;
const headed = process.argv.includes('--headed');

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? null;
}

async function resetMetrics(page) {
  await page.evaluate(() => window.__LUMEN_DIAGNOSTICS__.reset());
}

async function readMetrics(page) {
  return page.evaluate(() => window.__LUMEN_DIAGNOSTICS__.read());
}

async function waitForSamples(page, name, count) {
  await page.waitForFunction(
    ({sampleName, sampleCount}) => window.__LUMEN_DIAGNOSTICS__
      .read()
      .timings
      .filter((sample) => sample.name === sampleName).length >= sampleCount,
    {sampleName: name, sampleCount: count},
  );
}

async function dispatchRapidInputBurst(search) {
  return search.evaluate((element) => {
    if (!(element instanceof globalThis.HTMLInputElement)) throw new Error('Expected the launcher input');
    const setValue = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Missing native HTMLInputElement value setter');
    const startedAt = performance.now();
    for (let index = 1; index <= 30; index += 1) {
      setValue.call(element, `rapid-burst-${index}`);
      element.dispatchEvent(new globalThis.Event('input', {bubbles: true}));
    }
    return {synchronousDurationMs: performance.now() - startedAt};
  });
}

async function dispatchRapidSelectionBurst(search) {
  return search.evaluate((element) => {
    const startedAt = performance.now();
    for (let index = 1; index <= 30; index += 1) {
      element.dispatchEvent(new globalThis.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: index % 2 === 0 ? 'ArrowUp' : 'ArrowDown',
      }));
    }
    return {synchronousDurationMs: performance.now() - startedAt};
  });
}

async function hideAndReshowLauncher(page, search) {
  await page.keyboard.press('Escape');
  await page.locator('[data-launcher-visible="false"]').waitFor();
  await page.evaluate(() => window.dispatchEvent(new window.CustomEvent('lumen:diagnostics-show-launcher')));
  await page.locator('[data-launcher-visible="true"]').waitFor();
  await search.waitFor({state: 'visible'});
}

async function measureRefresh(page) {
  const {intervals, medianMs, p95Ms} = await page.evaluate(sampleFrameCadence);
  return {intervals, medianFrameIntervalMs: medianMs, p95FrameIntervalMs: p95Ms};
}

async function profile(baseUrl) {
  await mkdir(outputDirectory, {recursive: true});
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: !headed,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  const context = await browser.newContext({viewport: {width: 800, height: 540}});
  const page = await context.newPage();
  const browserVersion = browser.version();
  let traceStarted = false;

  try {
    await installReactRendererProbe(page);
    await page.goto(`${baseUrl}/?onboarded=1&service=memory`);
    const reactRenderers = await readReactRenderers(page);
    assert.deepEqual(reactRenderers.map(({bundleType}) => bundleType), [0], 'Production renderer required');
    const display = await page.evaluate(() => ({
      screenWidth: window.screen.width, screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio, visibility: document.visibilityState,
      userAgent: window.navigator.userAgent,
    }));
    let graphics = {available: false};
    let browserSession;
    try {
      browserSession = await browser.newBrowserCDPSession();
      const {gpu} = await browserSession.send('SystemInfo.getInfo');
      graphics = {
        available: true,
        devices: gpu.devices.map(({vendorString, deviceString, driverVersion}) => ({
          vendor: vendorString, device: deviceString, driverVersion,
        })),
        renderer: gpu.auxAttributes?.glRenderer ?? null,
        featureStatus: gpu.featureStatus,
        gpuCompositingEnabled: gpu.featureStatus?.gpu_compositing === 'enabled',
      };
    } catch {
      // Record unavailable GPU evidence rather than infer it from installed hardware.
    } finally {
      if (browserSession) await browserSession.detach();
    }
    const search = page.getByRole('searchbox', {name: 'Search files'});
    await search.waitFor({state: 'visible'});

    for (let index = 0; index < 6; index += 1) {
      await hideAndReshowLauncher(page, search);
    }
    await page.waitForTimeout(100);
    await resetMetrics(page);

    for (let index = 1; index <= 24; index += 1) {
      await hideAndReshowLauncher(page, search);
      await waitForSamples(page, 'launcher-visible', index);
    }
    const warmMetrics = await readMetrics(page);
    const warmSamples = warmMetrics.timings
      .filter((sample) => sample.name === 'launcher-visible')
      .map((sample) => sample.durationMs);

    for (let index = 0; index < 10; index += 1) {
      await search.fill(`warm-input-${index}`);
      await page.waitForTimeout(8);
    }
    await search.fill('');
    await page.waitForTimeout(50);
    await resetMetrics(page);
    for (let index = 1; index <= 30; index += 1) {
      await search.fill(`report-${index}`);
      await waitForSamples(page, 'input-response', index);
      await waitForSamples(page, 'input-next-frame', index);
      await page.waitForTimeout(40);
    }
    const inputMetrics = await readMetrics(page);
    await search.fill('report');
    await page.getByRole('grid', {name: 'Search results'}).waitFor();
    const refresh = await measureRefresh(page);
    const inputSamples = inputMetrics.timings
      .filter((sample) => sample.name === 'input-response')
      .map((sample) => sample.durationMs);

    const inputFrameSamples = inputMetrics.timings
      .filter((sample) => sample.name === 'input-next-frame')
      .map((sample) => sample.durationMs);
    // Let ordinary query updates settle past debounce; row selection is imperative.
    await resetMetrics(page);
    const ordinaryQueries = ['report', 'design', 'project', ''];
    const ordinaryMetrics = {reactCommits: [], browserLongTasks: []};
    const ordinaryCommitCounts = [];
    for (let index = 0; index < 24; index += 1) {
      await resetMetrics(page);
      await search.fill(ordinaryQueries[index % ordinaryQueries.length]);
      await page.waitForTimeout(250);
      const queryMetrics = await readMetrics(page);
      ordinaryMetrics.reactCommits.push(...queryMetrics.reactCommits);
      ordinaryMetrics.browserLongTasks.push(...queryMetrics.browserLongTasks);
      ordinaryCommitCounts.push(queryMetrics.reactCommits.length);
    }
    const ordinaryReactCommits = ordinaryMetrics.reactCommits;

    await resetMetrics(page);
    const rapidBurst = await dispatchRapidInputBurst(search);
    await waitForSamples(page, 'input-response', 30);
    await page.waitForTimeout(100);
    const rapidBurstMetrics = await readMetrics(page);
    const rapidBurstFinalValue = await search.inputValue();
    await search.fill('report');
    await page.getByRole('row').first().waitFor();

    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press(index % 2 === 0 ? 'ArrowDown' : 'ArrowUp');
      await page.waitForTimeout(12);
    }
    await page.waitForTimeout(100);
    await resetMetrics(page);
    for (let index = 1; index <= 120; index += 1) {
      await page.keyboard.press(index % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(12);
    }
    await waitForSamples(page, 'selection-paint', 120);
    await page.waitForTimeout(80);
    const selectionMetrics = await readMetrics(page);
    const selectionSamples = selectionMetrics.timings
      .filter((sample) => sample.name === 'selection-paint')
      .map((sample) => sample.durationMs);

    await resetMetrics(page);
    const rapidSelection = await dispatchRapidSelectionBurst(search);
    await waitForSamples(page, 'selection-paint', 30);
    await page.waitForTimeout(100);
    const rapidSelectionMetrics = await readMetrics(page);
    const rapidSelectionSelectedRows = await page
      .locator('[data-result-id][data-selected="true"]')
      .count();

    // Exercise activity indicator: initiate search, wait for it to settle to inactive state
    await search.fill('activity-test');
    await page.getByRole('grid', {name: 'Search results'}).waitFor();
    await page.waitForTimeout(100);
    await search.fill('');
    await page.waitForTimeout(200);

    // Measure active activity indicators AFTER the activity has settled.
    // This verifies that no indicators remain running after work completes.
    const activeActivityIndicators = await page
      .locator('[data-activity-running="true"]')
      .count();

    await page.goto(`${baseUrl}/?gallery=1&scenario=expanded-results&capture=1&theme=reduced-motion`);
    const row = page.getByRole('row').first();
    await row.waitFor();
    await resetMetrics(page);
    const hoverSamples = [];
    for (let index = 0; index < 80; index += 1) {
      hoverSamples.push(await sampleHover(row));
    }
    await page.waitForTimeout(100);
    const hoverToPaintSamples = hoverSamples.map((sample) => sample.responseMs);
    const hoverFrameIntervals = hoverSamples.map((sample) => sample.callbackIntervalMs);
    const hoverSynchronousDispatch = hoverSamples.map((sample) => sample.synchronousDispatchMs);
    const hoverMetrics = await readMetrics(page);

    await page.waitForTimeout(500);
    const activeAnimations = await page.evaluate(() => document
      .getAnimations()
      .filter((animation) => animation.playState === 'running').length);
    const session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    const before = await session.send('Performance.getMetrics');
    const idleStartedAt = Date.now();
    await page.waitForTimeout(1000);
    const elapsedSeconds = (Date.now() - idleStartedAt) / 1000;
    const after = await session.send('Performance.getMetrics');
    await session.send('HeapProfiler.collectGarbage');
    const afterGarbageCollection = await session.send('Performance.getMetrics');
    const metric = (items, name) => items.find((item) => item.name === name)?.value ?? 0;
    const idleCpuPercent = (
      metric(after.metrics, 'TaskDuration') - metric(before.metrics, 'TaskDuration')
    ) / elapsedSeconds * 100;
    const heapMegabytes = metric(afterGarbageCollection.metrics, 'JSHeapUsedSize') / (1024 * 1024);

    // Untimed lifecycle verification after all existing timed phases. Count real row
    // measurements without changing hover/input instrumentation or retained samples.
    await page.addInitScript(() => {
      window.__LUMEN_ROW_MEASUREMENTS__ = 0;
      const measure = globalThis.HTMLElement.prototype.getBoundingClientRect;
      globalThis.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.hasAttribute('data-result-id')) window.__LUMEN_ROW_MEASUREMENTS__ += 1;
        return measure.call(this);
      };
    });
    await page.goto(`${baseUrl}/?onboarded=1&service=memory`);
    await search.fill('report');
    await page.locator('[data-result-id][data-selected="true"]').waitFor();
    await page.waitForTimeout(500);
    const selectionAlignmentErrorPx = await page.evaluate(() => {
      const selected = document.querySelector('[data-result-id][data-selected="true"]');
      const capsule = document.querySelector('[data-selection-capsule]');
      if (!selected || !capsule) return null;
      const rowBounds = selected.getBoundingClientRect();
      const capsuleBounds = capsule.getBoundingClientRect();
      return Math.max(Math.abs(rowBounds.top - capsuleBounds.top), Math.abs(rowBounds.height - capsuleBounds.height));
    });
    await page.evaluate(() => { window.__LUMEN_ROW_MEASUREMENTS__ = 0; });
    await page.waitForTimeout(100);
    const settledSelectionMeasurements = await page.evaluate(() => window.__LUMEN_ROW_MEASUREMENTS__);
    // Simulate the typed native visibility store transition; this is browser lifecycle
    // evidence, not native HWND hide or presentation acceptance.
    await page.evaluate(() => window.__LUMEN_DIAGNOSTICS__.hideLauncher());
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__LUMEN_ROW_MEASUREMENTS__ = 0; });
    await page.waitForTimeout(100);
    const hiddenSelectionMeasurements = await page.evaluate(() => window.__LUMEN_ROW_MEASUREMENTS__);
    const hiddenAnimations = await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length);
    const hiddenActivityIndicators = await page.locator('[data-activity-running="true"]').count();

    const measured = {
      warmLauncherP95Ms: percentile(warmSamples, 0.95),
      inputResponseP95Ms: percentile(inputSamples, 0.95),
      inputToNextFrameP95Ms: percentile(inputFrameSamples, 0.95),
      selectionToPaintP95Ms: percentile(selectionSamples, 0.95),
      hoverToPaintP95Ms: percentile(hoverToPaintSamples, 0.95),
      hoverFrameIntervalP95Ms: percentile(hoverFrameIntervals, 0.95),
      hoverNominalFrameIntervalP95Ms: percentile(hoverSamples.map((sample) => sample.nominalFrameIntervalMs), 0.95),
      hoverReadySamples: hoverSamples.filter((sample) => sample.ready).length,
      hoverSynchronousDispatchMaxMs: Math.max(...hoverSynchronousDispatch),
      hoverBrowserLongTasksOver50Ms: hoverMetrics.browserLongTasks,
      ordinaryReactCommitP95Ms: percentile(ordinaryReactCommits, 0.95),
      ordinaryReactCommitSamples: ordinaryReactCommits.length,
      ordinaryBrowserLongTasksOver50Ms: ordinaryMetrics.browserLongTasks,
      repeatedBrowserLongTasksOver50Ms: selectionMetrics.browserLongTasks,
      activeAnimationsAfterSettle: activeAnimations,
      activeActivityIndicatorsAfterSettle: activeActivityIndicators,
      selectionAlignmentErrorPx,
      settledSelectionMeasurements,
      hiddenSelectionMeasurements,
      hiddenAnimations,
      hiddenActivityIndicators,
      idleCpuPercent,
      jsHeapMegabytes: heapMegabytes,
      observedRefreshEstimateHz: refresh.medianFrameIntervalMs === null ? null : Math.round(1000 / refresh.medianFrameIntervalMs),
      medianFrameIntervalMs: refresh.medianFrameIntervalMs,
      p95FrameIntervalMs: refresh.p95FrameIntervalMs,
      rapidBurstInputSamples: rapidBurstMetrics.timings
        .filter((sample) => sample.name === 'input-response').length,
      rapidBurstFinalValue,
      rapidBurstSynchronousDurationMs: rapidBurst.synchronousDurationMs,
      rapidBurstBrowserLongTasksOver50Ms: rapidBurstMetrics.browserLongTasks,
      rapidSelectionSamples: rapidSelectionMetrics.timings
        .filter((sample) => sample.name === 'selection-paint').length,
      rapidSelectionSelectedRows,
      rapidSelectionSynchronousDurationMs: rapidSelection.synchronousDurationMs,
      rapidSelectionBrowserLongTasksOver50Ms: rapidSelectionMetrics.browserLongTasks,
    };
    const effectivePaintFrameBudgetMs = Math.max(
      refresh.p95FrameIntervalMs,
      targetFrameBudgetMs,
    ) + frameSchedulingToleranceMs;
    // Nominal rendering cadence is independent of response callback execution times.
    const effectiveHoverFrameBudgetMs = Math.max(
      measured.hoverNominalFrameIntervalP95Ms,
      targetFrameBudgetMs,
    );
    const strict120Hz = evaluateRefreshTarget(measured, 120);
    const strict240Hz = evaluateRefreshTarget(measured, 240);
    const cadenceMeasurementAvailable = Number.isFinite(refresh.p95FrameIntervalMs) &&
      refresh.p95FrameIntervalMs > 0;
    const hoverCadenceMeasurementAvailable = Number.isFinite(measured.hoverNominalFrameIntervalP95Ms) &&
      measured.hoverNominalFrameIntervalP95Ms > 0;
    const environmentEligibility = {
      cadenceMeasurementAvailable,
      hoverCadenceMeasurementAvailable,
      strict120HzCadence: strict120Hz.cadence,
      strict240HzCadence: strict240Hz.cadence,
      cadenceAwareRelease: cadenceMeasurementAvailable && hoverCadenceMeasurementAvailable,
    };
    const budgets = {
      warmLauncherP95Ms: 20,
      nominal240HzPaintFrameMs: targetFrameBudgetMs,
      effectivePaintFrameBudgetMs,
      effectiveHoverFrameBudgetMs,
      inputResponseP95Ms: effectivePaintFrameBudgetMs,
      inputToNextFrameP95Ms: effectivePaintFrameBudgetMs,
      selectionToPaintP95Ms: effectivePaintFrameBudgetMs,
      hoverToPaintP95Ms: effectiveHoverFrameBudgetMs,
      ordinaryReactCommitP95Ms: 3,
      synchronousWorkMs: 16,
      browserLongTaskMs: 50,
      activeAnimationsAfterSettle: 0,
      activeActivityIndicatorsAfterSettle: 0,
      idleCpuPercent: 2,
      jsHeapMegabytes: 100,
    };
    const checks = {
      warmLauncher: measured.warmLauncherP95Ms < budgets.warmLauncherP95Ms,
      input: measured.inputResponseP95Ms < budgets.inputResponseP95Ms,
      inputNextFrame: inputFrameSamples.length === 30 &&
        measured.inputToNextFrameP95Ms < budgets.inputToNextFrameP95Ms,
      selection: measured.selectionToPaintP95Ms < budgets.selectionToPaintP95Ms,
      hover: measured.hoverToPaintP95Ms <= budgets.hoverToPaintP95Ms,
      hoverReadiness: measured.hoverReadySamples === 80,
      hoverSynchronousDispatch: measured.hoverSynchronousDispatchMaxMs < budgets.synchronousWorkMs,
      hoverBrowserLongTasks: measured.hoverBrowserLongTasksOver50Ms.length === 0,
      reactCommit: ordinaryReactCommits.length > 0 && measured.ordinaryReactCommitP95Ms < budgets.ordinaryReactCommitP95Ms,
      browserLongTasks: measured.repeatedBrowserLongTasksOver50Ms.length === 0,
      ordinaryBrowserLongTasks: measured.ordinaryBrowserLongTasksOver50Ms.length === 0,
      settledAnimations: measured.activeAnimationsAfterSettle === 0,
      settledActivityIndicator: measured.activeActivityIndicatorsAfterSettle ===
        budgets.activeActivityIndicatorsAfterSettle,
      selectionAlignment: Number.isFinite(selectionAlignmentErrorPx) && selectionAlignmentErrorPx <= 1,
      settledMeasurements: settledSelectionMeasurements === 0,
      hiddenMeasurements: hiddenSelectionMeasurements === 0,
      hiddenAnimations: hiddenAnimations === 0,
      hiddenActivityIndicator: hiddenActivityIndicators === 0,
      idleCpu: measured.idleCpuPercent < budgets.idleCpuPercent,
      memory: measured.jsHeapMegabytes < budgets.jsHeapMegabytes,
      environmentEligibility: environmentEligibility.cadenceAwareRelease,
      rapidBurst: measured.rapidBurstInputSamples === 30 &&
        measured.rapidBurstFinalValue === 'rapid-burst-30' &&
        measured.rapidBurstSynchronousDurationMs < budgets.synchronousWorkMs &&
        measured.rapidBurstBrowserLongTasksOver50Ms.length === 0,
      rapidSelection: measured.rapidSelectionSamples === 30 &&
        measured.rapidSelectionSelectedRows === 1 &&
        measured.rapidSelectionSynchronousDurationMs < budgets.synchronousWorkMs &&
        measured.rapidSelectionBrowserLongTasksOver50Ms.length === 0,
    };
    const summary = {
      generatedAt: new Date().toISOString(),
      gitSha: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      sourceWorktreeDirty: execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim().length > 0,
      browser: {name: 'Microsoft Edge', version: browserVersion, headless: !headed},
      react: {build: 'production-profiling', renderers: reactRenderers},
      instrumentation: {timedPhaseTracing: false, timedPhaseScreenshots: false, tracePhase: 'separate interaction study after measurements'},
      display,
      graphics,
      measurementBoundary: 'input-response is synchronous handler time; input-next-frame, selection-paint and hover timings end at an actual requestAnimationFrame callback before presentation. React samples are a separate 24-query phase with 250 ms settling, not imperative row selection. Cadence and GPU evidence describe this Edge process, not native WebView2 presentation.',
      profile: 'warm deterministic browser adapter, 800x540 viewport, 30 paced input samples, 120 paced selection samples, 80 fresh hover transitions with paired actual callback endpoints, independent next-callback state and token-color readiness, separate nominal rAF cadence, direct dispatch timing, renderer-side synchronous 30-event input and selection bursts, plus activity-indicator settle verification',
      hoverEvidenceBoundary: 'Legacy hoverToPaint fields measure dispatch to the next actual animation callback, with independent computed-style readiness; they do not measure compositor paint. hoverFrameInterval fields use actual callback endpoints; nominal rendering timestamps and callback offsets are retained in samples.hover.',
      lifecycleEvidenceBoundary: 'Selection alignment and settled/hidden row-measurement counts run after timed phases on a fresh browser page. Hidden state uses the launcher visibility store, not native HWND hiding. Each zero-measurement observation is 100 ms after 500 ms settling. Native and document visibility observer cleanup also have focused component regressions.',
      target: {
        refreshRateHz: 240,
        frameBudgetMs: targetFrameBudgetMs,
        frameSchedulingToleranceMs,
        effectivePaintFrameBudgetMs,
        effectiveHoverFrameBudgetMs,
      },
      environmentEligibility,
      budgets,
      measured,
      strict120Hz,
      strict240Hz,
      checks,
      passed: Object.values(checks).every(Boolean),
      samples: {
        frameIntervalMs: refresh.intervals,
        warmLauncherMs: warmSamples,
        inputResponseMs: inputSamples,
        inputToNextFrameMs: inputFrameSamples,
        selectionToPaintMs: selectionSamples,
        hoverToPaintMs: hoverToPaintSamples,
        hoverFrameIntervalMs: hoverFrameIntervals,
        hoverSynchronousDispatchMs: hoverSynchronousDispatch,
        hover: hoverSamples,
        reactCommitMs: ordinaryReactCommits,
        ordinaryQueryPhase: {queries: ordinaryQueries, count: 24, settlingMs: 250, commitCounts: ordinaryCommitCounts},
        inputReactCommitMs: inputMetrics.reactCommits,
        selectionReactCommitMs: selectionMetrics.reactCommits,
      },
    };
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.passed) process.exitCode = 1;
    process.stdout.write(`${summaryPath}\n${JSON.stringify(measured, null, 2)}\n`);
    // Trace snapshots are a separate visual study after the timed samples.
    await context.tracing.start({screenshots: true, snapshots: true, sources: true});
    traceStarted = true;
    await page.goto(`${baseUrl}/?onboarded=1&service=memory`);
    await search.fill('report');
    await page.getByRole('grid', {name: 'Search results'}).waitFor();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(400);
  } finally {
    if (traceStarted) await context.tracing.stop({path: tracePath});
    await context.close();
    await browser.close();
  }
}

await withLumenPerformanceServer(profile);
