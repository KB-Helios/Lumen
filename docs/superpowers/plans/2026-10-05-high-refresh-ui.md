# High-refresh UI implementation plan

**Goal:** Preserve Lumen's tight, subtle motion while enabling compositor
animation and honest 120/240 Hz performance evidence.

**Architecture:** Keep the existing typed services and motion tokens. Use
Motion's native transform animations for transitions and the selection spring.
Keep diagnostics on demand and measure input handlers and frame boundaries
separately.

**Tech stack:** React 19, Motion 12, WAAPI, Lottie 5, GSAP 3, Tauri 2/WebView2,
Bun, Vitest, Playwright with installed Microsoft Edge.

## Constraints

- No new dependencies, frame timers, permanent will-change, native geometry
  changes, or GPU/vsync disabling/forcing flags.
- Preserve reduced motion, forced colors, keyboard selection, and cleanup.
- Use the existing isolated worktree and Bun for verification.

## 1. Establish evidence

- [x] Read motion/search architecture and current library documentation.
- [x] Install frozen dependencies and capture a fresh baseline profile.
- [x] Inspect display/GPU and distinguish handler timing from presentation.

## 2. Remove frame caps and main-thread movement

Files: ActivityIndicator and its existing tests; SelectionCapsule and a focused
geometry/lifecycle test; GlassCommandPalette, ExpandedWorkspace, FilterChips,
PreviewPane, PreviewSkeleton, SettingsShell, and OnboardingFlow.

- [x] Make the existing lifecycle test require `setSubframe(true)` and run it
  before implementing interpolation.
- [x] Test virtual-row placement, first-position snapping, interrupted native
  movement, reduced motion, and animation cancellation before rewriting capsule
  movement with `animate(element, {transform}, motionTokens.selectionSpring)`.
- [x] Change suitable x/y transitions to direct translate transform strings;
  preserve layout projection for scope/chip layout.
- [x] Run focused unit tests and real Edge animation/geometry tests.
- [x] Coalesce rapid selection and collection changes into one display-frame
  measurement/retarget, keeping intent immediate and cancelling queued work.

## 3. Measure high-refresh behavior accurately

Files: diagnostics.store/types/overlay, SearchInput, performance-profile.mjs,
performance.spec.ts, and a focused diagnostics store test.

- [x] Test 120/240/500 Hz sampling, a partial first frame, unmeasured cadence,
  and timeout cancellation. Then fix the on-demand sampler and presentation.
- [x] Record `input-next-frame` separately from `input-response` and label
  diagnostic frame boundaries accurately.
- [x] Add strict 120/240 Hz cadence and work checks to the profile, preserving
  cadence-aware release checks. Record CDP GPU evidence and optional `--headed`.
- [x] Verify each new measurement with an actual Edge run.
- [x] Isolate tracing overhead: time interactions without DOM snapshots or
  screenshots, then capture a separate visual interaction trace.

## 4. Complete verification and evidence

- [x] Run `bun run typecheck`, `bun run lint`, `bun run test`, and
  `bun run test:e2e` in order, then `bun run build`.
- [x] Run script contract tests with Bun.
- [x] Regenerate `capture:gallery`, `record:interactions`, and `profile`.
- [x] Compile and probe the real native window with isolated app data; record
  GPU compositing, active transform-layer acceleration, cadence, and alignment.
- [x] Inspect the contact sheet and representative captures, review the diff,
  update motion/performance docs with fresh measurements and evidence limits.
- [x] Report only verified results and leave changes reviewable in this worktree.
