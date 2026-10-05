import assert from 'node:assert/strict';
import test from 'node:test';

import {evaluateRefreshTarget} from './refresh-budget.mjs';

const responsive = {
  inputResponseP95Ms: 0.1,
  inputToNextFrameP95Ms: 2,
  selectionToPaintP95Ms: 2,
  hoverToPaintP95Ms: 3,
  ordinaryReactCommitP95Ms: 1,
  rapidBurstSynchronousDurationMs: 1,
  rapidSelectionSynchronousDurationMs: 2,
  hoverSynchronousDispatchMaxMs: 1,
};

test('a fast handler on a 60 Hz renderer cannot claim 120 or 240 Hz', () => {
  const measured = {...responsive, p95FrameIntervalMs: 16.7, hoverFrameIntervalP95Ms: 16.7};
  for (const rate of [120, 240]) {
    const result = evaluateRefreshTarget(measured, rate);
    assert.equal(result.input, true);
    assert.equal(result.cadence, false);
    assert.equal(result.passed, false);
  }
});

test('120 Hz cadence passes its target but does not pass 240 Hz', () => {
  const measured = {...responsive, p95FrameIntervalMs: 8.4, hoverFrameIntervalP95Ms: 8.4};
  assert.equal(evaluateRefreshTarget(measured, 120).passed, true);
  assert.equal(evaluateRefreshTarget(measured, 240).passed, false);
});

test('240 Hz accepts 0.1 ms timestamp rounding while retaining strict work budgets', () => {
  const measured = {...responsive, p95FrameIntervalMs: 4.2, hoverFrameIntervalP95Ms: 4.2};
  assert.equal(evaluateRefreshTarget(measured, 240).passed, true);
  assert.equal(evaluateRefreshTarget({...measured, inputToNextFrameP95Ms: 6}, 240).passed, false);
  assert.equal(evaluateRefreshTarget({...measured, rapidSelectionSynchronousDurationMs: 8}, 240).passed, false);
});

test('unknown or stalled frame cadence never passes', () => {
  for (const interval of [0, NaN, Infinity, 100]) {
    const measured = {...responsive, p95FrameIntervalMs: interval, hoverFrameIntervalP95Ms: interval};
    assert.equal(evaluateRefreshTarget(measured, 240).passed, false);
  }
});
