import assert from 'node:assert/strict';
import test from 'node:test';

test('strict targets keep exact budgets and require complete cadence and readiness', async () => {
  const {evaluateRefreshTarget} = await import('./refresh-budget.mjs').catch(() => ({}));
  assert.equal(typeof evaluateRefreshTarget, 'function');
  const measured = {
    p95FrameIntervalMs: 4, hoverNominalFrameIntervalP95Ms: 4,
    inputResponseP95Ms: 0.1, inputToNextFrameP95Ms: 2,
    selectionToPaintP95Ms: 3, hoverToPaintP95Ms: 3,
    hoverReadySamples: 80, ordinaryReactCommitP95Ms: 1,
    ordinaryReactCommitSamples: 12, rapidBurstSynchronousDurationMs: 2,
    rapidSelectionSynchronousDurationMs: 2, hoverSynchronousDispatchMaxMs: 0.2,
  };
  assert.equal(evaluateRefreshTarget(measured, 240).passed, true);
  assert.equal(evaluateRefreshTarget(measured, 120).frameBudgetMs, 1000 / 120);
  assert.equal(evaluateRefreshTarget({...measured, hoverReadySamples: 79}, 240).passed, false);
  assert.equal(evaluateRefreshTarget({...measured, ordinaryReactCommitP95Ms: null, ordinaryReactCommitSamples: 0}, 240).passed, false);
  assert.equal(evaluateRefreshTarget({...measured, p95FrameIntervalMs: 1000 / 240 + 0.01}, 240).cadence, false);
  assert.equal(evaluateRefreshTarget({...measured, inputToNextFrameP95Ms: null}, 240).input, false);
  assert.equal(evaluateRefreshTarget({...measured, inputToNextFrameP95Ms: 1000 / 240}, 240).input, false);
});
