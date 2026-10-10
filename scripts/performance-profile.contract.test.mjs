import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const performanceSpec = await readFile(new URL('../tests/e2e/performance.spec.ts', import.meta.url), 'utf8');
const performanceProfile = await readFile(new URL('./performance-profile.mjs', import.meta.url), 'utf8');

test('rapid input is dispatched as one renderer-side burst in both performance runners', () => {
  for (const source of [performanceSpec, performanceProfile]) {
    assert.match(source, /dispatchRapidInputBurst\(/);
    assert.match(source, /synchronousDurationMs/);
    assert.match(source, /toBeLessThan\(16\)|SynchronousDurationMs < budgets\.synchronousWorkMs/);
    assert.doesNotMatch(source, /search\.fill\(`rapid-burst-/);
  }
});

test('rapid selection is dispatched and timed as one renderer-side burst in both performance runners', () => {
  for (const source of [performanceSpec, performanceProfile]) {
    assert.match(source, /dispatchRapidSelectionBurst\(/);
    assert.match(source, /rapidSelection.*synchronousDurationMs|rapidSelectionSynchronousDurationMs/s);
  }
});

test('the dedicated profile preserves strict 240 Hz results beside its observed-frame release budget', () => {
  assert.match(performanceProfile, /strict240Hz/);
  assert.match(performanceProfile, /effectivePaintFrameBudgetMs/);
  assert.match(performanceProfile, /environmentEligibility/);
});

test('next-frame input and ordinary commits cannot be reported as assumed zero measurements', () => {
  for (const source of [performanceSpec, performanceProfile]) {
    assert.match(source, /input-next-frame/);
    assert.match(source, /ordinaryReactCommits/);
    assert.match(source, /ordinaryReactCommits\.length/);
  }
  assert.match(performanceProfile, /strict120Hz/);
  assert.match(performanceProfile, /frameIntervalMs: refresh\.intervals/);
});

test('timed samples are complete before the separate trace study starts', () => {
  assert.ok(performanceProfile.indexOf('await context.tracing.start') > performanceProfile.indexOf('await writeFile(summaryPath'));
  assert.match(performanceProfile, /timedPhaseTracing: false/);
  assert.match(performanceProfile, /SystemInfo\.getInfo/);
  assert.match(performanceProfile, /LUMEN_PROFILE_OUTPUT_DIR/);
});

test('hover uses paired frame intervals and an independent synchronous dispatch guard in both runners', () => {
  const e2eHover = performanceSpec.split("test('hover, idle work")[1] ?? '';
  const profileHover = performanceProfile.split('const hoverSamples = []')[1] ?? '';
  for (const source of [e2eHover, profileHover]) {
    assert.match(source, /hoverFrameIntervals/);
    assert.match(source, /synchronousDispatchMs/);
    assert.match(source, /hoverSynchronousDispatch/);
  }
  assert.doesNotMatch(e2eHover, /measureFrameCadence\(/);
});

test('the Long Tasks API is reported accurately as a 50 ms browser signal', () => {
  for (const source of [performanceSpec, performanceProfile]) {
    assert.match(source, /browserLongTasks/);
    assert.doesNotMatch(source, /LongTasksOver16Ms|longTasks\.filter\(\(duration\) => duration > 16\)/);
  }
  assert.match(performanceProfile, /BrowserLongTasksOver50Ms/);
  assert.match(performanceProfile, /browserLongTaskMs:\s*50/);
});
