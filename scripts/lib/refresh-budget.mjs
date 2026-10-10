export function evaluateRefreshTarget(measured, refreshRateHz) {
  const frameBudgetMs = 1000 / refreshRateHz;
  const within = (value) => Number.isFinite(value) && value >= 0 && value < frameBudgetMs;
  const cadence = (value) => Number.isFinite(value) && value > 0 && value <= frameBudgetMs;
  const checks = {
    cadence: cadence(measured.p95FrameIntervalMs) && cadence(measured.hoverNominalFrameIntervalP95Ms),
    input: within(measured.inputResponseP95Ms) && within(measured.inputToNextFrameP95Ms),
    selection: within(measured.selectionToPaintP95Ms),
    hover: within(measured.hoverToPaintP95Ms) && measured.hoverReadySamples === 80,
    reactCommit: measured.ordinaryReactCommitSamples > 0 && within(measured.ordinaryReactCommitP95Ms),
    synchronousWork: within(measured.rapidBurstSynchronousDurationMs) &&
      within(measured.rapidSelectionSynchronousDurationMs) && within(measured.hoverSynchronousDispatchMaxMs),
  };
  return {refreshRateHz, frameBudgetMs, ...checks, passed: Object.values(checks).every(Boolean)};
}
