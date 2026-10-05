import {expect, test, type Page} from '@playwright/test';

const frameSchedulingToleranceMs = 2;

test.describe.configure({mode: 'serial'});
test.use({
  trace: 'off',
  launchOptions: {
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  },
});

test('keeps the ready activity indicator settled', async ({page}) => {
  await page.goto('/?onboarded=1&service=memory');

  await page.getByRole('searchbox', {name: 'Search files'}).fill('report');
  await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();

  const indicator = page.locator('[data-activity-indicator]');
  await expect(indicator).toHaveAttribute('data-activity-state', 'idle');
  await expect(page.locator('[data-activity-running="true"]')).toHaveCount(0);
});

interface DiagnosticsMetrics {
  timings: Array<{name: string; durationMs: number}>;
  browserLongTasks: number[];
  reactCommits: number[];
}

function percentile(values: readonly number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

async function resetMetrics(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {__LUMEN_DIAGNOSTICS__: {reset(): void}}).__LUMEN_DIAGNOSTICS__.reset();
  });
}

async function readMetrics(page: Page): Promise<DiagnosticsMetrics> {
  return page.evaluate(() => (
    window as unknown as {__LUMEN_DIAGNOSTICS__: {read(): DiagnosticsMetrics}}
  ).__LUMEN_DIAGNOSTICS__.read());
}

async function waitForSamples(page: Page, name: string, count: number) {
  await page.waitForFunction(
    ({sampleName, sampleCount}) => {
      const diagnostics = (window as unknown as {
        __LUMEN_DIAGNOSTICS__: {read(): DiagnosticsMetrics};
      }).__LUMEN_DIAGNOSTICS__.read();
      return diagnostics.timings.filter((sample) => sample.name === sampleName).length >= sampleCount;
    },
    {sampleName: name, sampleCount: count},
  );
}

async function dispatchRapidInputBurst(search: ReturnType<Page['getByRole']>) {
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

async function dispatchRapidSelectionBurst(search: ReturnType<Page['getByRole']>) {
  return search.evaluate((element) => {
    const startedAt = performance.now();
    for (let index = 1; index <= 30; index += 1) {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: index % 2 === 0 ? 'ArrowUp' : 'ArrowDown',
      }));
    }
    return {synchronousDurationMs: performance.now() - startedAt};
  });
}

async function hideAndReshowLauncher(page: Page, search: ReturnType<Page['getByRole']>) {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-launcher-visible="false"]')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lumen:diagnostics-show-launcher')));
  await expect(page.locator('[data-launcher-visible="true"]')).toHaveCount(1);
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
}

async function measureFrameCadence(page: Page, sampleCount = 60) {
  return page.evaluate(async (count) => {
    const intervals: number[] = [];
    let previous: number | undefined;
    await new Promise<void>((resolve) => {
      const sample = (now: number) => {
        if (previous !== undefined && now > previous) intervals.push(now - previous);
        previous = now;
        if (intervals.length >= count) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    intervals.sort((left, right) => left - right);
    return {
      medianMs: intervals[Math.floor(intervals.length / 2)] ?? 16.67,
      p95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? 16.67,
    };
  }, sampleCount);
}

test('warm launcher and ordinary interactions stay inside browser budgets', async ({page}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({width: 800, height: 540});
  await page.goto('/?onboarded=1&service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await expect(search).toBeFocused();

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
  const warmOpenP95 = percentile(
    warmMetrics.timings.filter((sample) => sample.name === 'launcher-visible').map((sample) => sample.durationMs),
    0.95,
  );
  expect(warmOpenP95).toBeLessThan(20);

  await resetMetrics(page);
  for (let index = 1; index <= 30; index += 1) {
    await search.fill(`report-${index}`);
    await waitForSamples(page, 'input-response', index);
    await waitForSamples(page, 'input-next-frame', index);
    await page.waitForTimeout(40);
  }
  const inputMetrics = await readMetrics(page);
  await search.fill('report');
  await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();
  const frameCadence = await measureFrameCadence(page);
  const observedFrameBudget = Math.max(frameCadence.p95Ms, 1000 / 240) +
    frameSchedulingToleranceMs;
  const inputP95 = percentile(
    inputMetrics.timings.filter((sample) => sample.name === 'input-response').map((sample) => sample.durationMs),
    0.95,
  );
  expect(inputP95).toBeLessThan(observedFrameBudget);
  const inputFrameSamples = inputMetrics.timings
    .filter((sample) => sample.name === 'input-next-frame').map((sample) => sample.durationMs);
  expect(inputFrameSamples).toHaveLength(30);
  expect(percentile(inputFrameSamples, 0.95)).toBeLessThan(observedFrameBudget);

  await resetMetrics(page);
  const rapidBurst = await dispatchRapidInputBurst(search);
  await waitForSamples(page, 'input-response', 30);
  await page.waitForTimeout(100);
  const rapidBurstMetrics = await readMetrics(page);
  await expect(search).toHaveValue('rapid-burst-30');
  expect(rapidBurst.synchronousDurationMs).toBeLessThan(16);
  expect(rapidBurstMetrics.browserLongTasks).toHaveLength(0);
  await search.fill('report');
  await expect(page.getByRole('row').first()).toBeVisible();

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
  await page.waitForTimeout(100);
  const selectionMetrics = await readMetrics(page);
  expect(selectionMetrics.timings.filter((sample) => sample.name === 'selection-paint')).toHaveLength(120);
  const selectionP95 = percentile(
    selectionMetrics.timings.filter((sample) => sample.name === 'selection-paint').map((sample) => sample.durationMs),
    0.95,
  );
  const ordinaryCommitP95 = percentile(selectionMetrics.reactCommits, 0.95);
  expect(selectionP95).toBeLessThan(observedFrameBudget);
  expect(ordinaryCommitP95).toBeLessThan(3);
  expect(selectionMetrics.browserLongTasks).toHaveLength(0);

  await resetMetrics(page);
  const rapidSelection = await dispatchRapidSelectionBurst(search);
  await waitForSamples(page, 'selection-paint', 30);
  await page.waitForTimeout(100);
  const rapidSelectionMetrics = await readMetrics(page);
  await expect(page.locator('[data-result-id][data-selected="true"]')).toHaveCount(1);
  expect(rapidSelection.synchronousDurationMs).toBeLessThan(16);
  expect(rapidSelectionMetrics.browserLongTasks).toHaveLength(0);
});

test('hover, idle work, animation count, and browser heap remain bounded', async ({page, context}) => {
  await page.setViewportSize({width: 800, height: 540});
  await page.goto('/?gallery=1&scenario=expanded-results&capture=1&theme=reduced-motion');
  const row = page.getByRole('row').first();
  await expect(row).toBeVisible();

  await resetMetrics(page);
  const hoverSamples: Array<{hoverToPaintMs: number; frameIntervalMs: number; synchronousDispatchMs: number}> = [];
  for (let index = 0; index < 80; index += 1) {
    hoverSamples.push(await row.evaluate((element) => new Promise((resolve) => {
      requestAnimationFrame((frameStartedAt) => {
        const hoverStartedAt = performance.now();
        element.dispatchEvent(new PointerEvent('pointerover', {bubbles: true, pointerType: 'mouse'}));
        const synchronousDispatchMs = performance.now() - hoverStartedAt;
        requestAnimationFrame((frameEndedAt) => resolve({
          hoverToPaintMs: performance.now() - hoverStartedAt,
          frameIntervalMs: frameEndedAt - frameStartedAt,
          synchronousDispatchMs,
        }));
      });
    })));
    await page.waitForTimeout(12);
  }
  await page.waitForTimeout(100);
  const hoverToPaintSamples = hoverSamples.map((sample) => sample.hoverToPaintMs);
  const hoverFrameIntervals = hoverSamples.map((sample) => sample.frameIntervalMs);
  const hoverSynchronousDispatch = hoverSamples.map((sample) => sample.synchronousDispatchMs);
  const hoverMetrics = await readMetrics(page);
  const hoverFrameBudget = Math.max(percentile(hoverFrameIntervals, 0.95), 1000 / 240);
  expect(percentile(hoverToPaintSamples, 0.95)).toBeLessThan(hoverFrameBudget);
  expect(Math.max(...hoverSynchronousDispatch)).toBeLessThan(16);
  expect(hoverMetrics.browserLongTasks).toHaveLength(0);

  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);

  const session = await context.newCDPSession(page);
  await session.send('Performance.enable');
  const before = await session.send('Performance.getMetrics');
  const startedAt = Date.now();
  await page.waitForTimeout(1000);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const after = await session.send('Performance.getMetrics');
  await session.send('HeapProfiler.collectGarbage');
  const afterGarbageCollection = await session.send('Performance.getMetrics');
  const metric = (items: typeof before.metrics, name: string) => items.find((item) => item.name === name)?.value ?? 0;
  const idleCpuPercent = (metric(after.metrics, 'TaskDuration') - metric(before.metrics, 'TaskDuration')) / elapsedSeconds * 100;
  const heapMegabytes = metric(afterGarbageCollection.metrics, 'JSHeapUsedSize') / (1024 * 1024);

  expect(idleCpuPercent).toBeLessThan(2);
  expect(heapMegabytes).toBeLessThan(100);
});

test('the static palette keeps one answer region and exposes diagnostics instrumentation', async ({page}) => {
  await page.setViewportSize({width: 800, height: 540});
  await page.goto('/?gallery=1&scenario=ai-streaming&capture=1');

  await expect(page.getByTestId('answer-region')).toHaveCount(1);
  await expect(page.getByRole('button', {name: 'Stop answer'})).toBeVisible();
  await page.waitForTimeout(250);
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await page.waitForTimeout(500);
  expect(await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
  )).toBe(0);

  const metrics = await readMetrics(page);
  expect(Array.isArray(metrics.timings)).toBe(true);
  expect(Array.isArray(metrics.reactCommits)).toBe(true);
});
