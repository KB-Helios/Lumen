// Cadence allows one 0.1 ms timestamp quantum; interaction work stays strict.
export function evaluateRefreshTarget(measured, refreshRateHz) {
  const frameBudgetMs = 1000 / refreshRateHz;
  const hasCadence = (interval) => Number.isFinite(interval) && interval > 0 &&
    interval <= frameBudgetMs + 0.1;
  const checks = {
    cadence: hasCadence(measured.p95FrameIntervalMs) &&
      hasCadence(measured.hoverFrameIntervalP95Ms),
    input: measured.inputResponseP95Ms < frameBudgetMs &&
      measured.inputToNextFrameP95Ms < frameBudgetMs,
    selection: measured.selectionToPaintP95Ms < frameBudgetMs,
    hover: measured.hoverToPaintP95Ms < frameBudgetMs,
    reactCommit: measured.ordinaryReactCommitP95Ms < frameBudgetMs,
    synchronousWork: Math.max(
      measured.rapidBurstSynchronousDurationMs,
      measured.rapidSelectionSynchronousDurationMs,
      measured.hoverSynchronousDispatchMaxMs,
    ) < frameBudgetMs,
  };
  return {refreshRateHz, frameBudgetMs, ...checks, passed: Object.values(checks).every(Boolean)};
}
