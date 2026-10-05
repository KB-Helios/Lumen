# Lumen Design Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver the approved neutral visual refinement with usable constrained layouts and consistent accessible motion.

**Architecture:** Keep theme, material, and timing ownership in the shared design system. Measure the actual launcher content region for preview eligibility and use CSS container queries for result metadata and management rows. Preserve all typed service, security, persistence, and native geometry boundaries.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, React Aria Components, Motion 12, existing Lottie/GSAP, Bun, Vitest, and Edge Playwright.

## Global Constraints

- Read the approved spec in `docs/superpowers/specs/2026-10-05-lumen-design-refinement.md`.
- Use `rtk` for shell commands and Bun for JavaScript tasks.
- Retain the 18px outer radius, 12px control radius, and graphite/off-white anchors. The user's approved follow-up replaces the original teal accent with blue.
- Retain 90ms hover, 72ms press, 120ms selection, 160ms preview/open, 190ms reveal, 210ms page, and at most 80ms reduced-motion fade.
- Do not change native geometry, credentials, consent rules, process ownership, search semantics, or backend services.
- Keep targets at least 32 logical pixels high; preserve React Aria keyboard behavior and themed portals.
- Keep continuous motion to transform/opacity, preserve active-only loading motion, and add no dependencies.

### Task 1: Behavioral regressions and actual workspace sizing

**Files:** `tests/e2e/design-refinement.spec.ts`, `tests/e2e/dpi-responsive.spec.ts`, `src/features/launcher/ExpandedWorkspace.tsx`, its test, `src/features/answer/AnswerPanel.tsx`, `src/features/results/ResultGrid.tsx`, `ResultRow.tsx`, `src/features/preview/PreviewPane.tsx`.

**Interfaces:** Preserve `ExpandedWorkspaceProps`, `AnswerPanelProps`, and `SearchService`. Observe the result/preview content element with `ResizeObserver`; update the preview eligibility boolean only when a threshold changes. Automatic preview requires 800px of real workspace width; always requires 760px. Both require 220px of usable content height.

- [x] Add a regression that measures the result scroll viewport itself:
  ```ts
  await page.goto('/?gallery=1&scenario=constrained-work-area&capture=1');
  const viewport = page.getByRole('grid', {name: 'Search results'}).locator('..');
  await expect.poll(() => viewport.evaluate(el => el.clientHeight)).toBeGreaterThanOrEqual(58);
  await expect(page.getByRole('region', {name: 'File preview'})).toBeHidden();
  ```
- [x] Run `rtk bun run test:e2e -- tests/e2e/design-refinement.spec.ts`; confirm the viewport regression fails with zero height.
- [x] Bound answers and results independently. Compact the answer toolbar by keeping Stop/Copy beside the mode control; keep sources available. Use an inner scroll region when large text cannot fit both primary regions simultaneously. Keep actions and status outside that scroll region.
- [x] Add result-column container queries for metadata, remove the preview frame's fixed minimum height, and resolve preview from measured content width/height. Update unit tests to provide real-element measurement at the DOM boundary rather than window media-query assumptions.
- [x] Run the focused workspace/component tests and Edge design/dpi regressions; confirm nonzero scroll regions, containment, and keyboard actions.

### Task 2: Shared visual language and motion

**Files:** `src/design-system/global.css`, `src/design-system/primitives/LumenSurface.tsx`, primitive/CSS tests, `src/components/ui/GlassCommandPalette.tsx`, `src/features/launcher/CollapsedLauncher.tsx`, `src/features/launcher/ScopeRail.tsx`, `scripts/capture-gallery.mjs`.

**Interfaces:** Existing `--lumen-*` semantic colors and material attributes remain authoritative. Add CSS timing variables `--lumen-duration-hover`, `--lumen-duration-press`, `--lumen-duration-selection`, `--lumen-duration-open`, `--lumen-duration-close`, `--lumen-duration-page` matching the existing TypeScript motion contract. Settings controls consume those variables.

- [x] Align the palette surface/text/borders with semantic tokens, improve quiet-text contrast, and reduce additive glow. Preserve system colors and opaque modes.
- [x] Preserve three inaccessible surface decoration nodes but make tint/luminosity subtle; keep one exterior shadow and an inner edge.
- [x] Keep a single owner for workspace reveal. Use shared short CSS entering/exiting transitions for popovers and confirmation overlays, including reduced-motion overrides.
- [x] Use fixed bounded chrome gutters/heights so enlarged text can scroll within its content region.
- [x] Verify the existing appearance/primitive tests and visually inspect dark, light, opaque, and forced-colors states.

### Task 3: Responsive settings and onboarding (independent agent)

**Files:** `src/features/settings/SettingsShell.tsx`, `SettingsNav.tsx`, settings components/pages that need containment, gateway presentation components, `src/features/onboarding/OnboardingFlow.tsx`, `OnboardingScene.tsx`, `RootSelectionScene.tsx`, `src/features/computer-use/ComputerUsePanel.tsx`, and `tests/e2e/settings-refinement.spec.ts`.

**Interfaces:** Consume semantic tokens and the timing variables in Task 2. Own no edits to `global.css`, launcher/results/answer code, service files, or the Task 1 test file. Named Tailwind settings container queries may be used directly in component classes. Retain all public props and accessible names.

- [x] Add and run the navigation regression before editing components:
  ```ts
  await page.goto('/?gallery=1&scenario=settings-general&capture=1&scale=200');
  const nav = page.getByRole('navigation', {name: 'Settings'});
  await expect.poll(() => nav.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  ```
- [x] Use a bounded navigation rail, wrapping text, stable page padding, and independent vertical scrolling. Stack settings rows when the content container is narrow. Bound fields/popovers and wrap route/provider/consent actions.
- [x] Replace the remounting settings presence controller with a short entrance on the accessible active panel. Reset the page scroll position on page changes while keeping focus in navigation.
- [x] Make onboarding's scene scroll independently with bounded choice/root content. Keep the primary action, header, directional transition, and backend completion behavior intact.
- [x] Reuse the dialog choreography and shared motion variables for controls; retain 32px targets and all Computer Use approval actions.
- [x] Run relevant unit tests and the agent-owned Edge regression; report exact touched files and outcomes for integration review.

### Task 4: Integrated verification, evidence, and review

**Files:** current screenshot/recording/performance artifacts, evidence generators if they capture an unfinished lazy preview, architecture documentation, and a final design report under `docs/reports/`.

- [x] Review and integrate the independent changes; resolve conflicts without overwriting another owner's edits.
- [x] Run, in order: `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run test`, `rtk bun run test:e2e`, `rtk bun run build`.
- [x] Regenerate evidence with `rtk bun run capture:gallery`, `rtk bun run record:interactions`, and `rtk bun run profile`. Capture completed previews only after their intended state is visible.
- [x] Inspect representative images/recordings, ensure the current registry is fully represented, and assess measured performance without asserting strict 240Hz eligibility.
- [x] Request an independent code review, address actionable findings, and rerun checks affected by any follow-up changes.
- [x] Update documentation and the completed checklist, run `rtk git diff --check`, commit the local work, and report concrete changes and verification boundaries.

### Task 5: Blue accent follow-up and publication

**Files:** `src/design-system/global.css`, current design documentation, screenshot/recording/performance artifacts, and the final validation report.

**Interfaces:** Change only the existing `--lumen-accent` and `--lumen-focus` values: light `#0066cc` / `#005fcc`, dark `#5aa2ff` / `#80baff`. Existing inverse text, status tokens, neutral selection fills, and system-color overrides remain authoritative.

- [x] Replace the four shared accent/focus values and update current design documentation.
- [x] Run the existing browser primary-action contrast regression and inspect focus, selected navigation, primary actions, and activity in both themes. Require primary-action contrast of at least 4.5:1.
- [x] Run typecheck, zero-warning lint, all unit/component tests, all Edge e2e tests, and the frontend production build in repository order.
- [x] Commit the final source, regenerate all 57 gallery states, six recordings, and the performance summary; inspect representative output and record the same source revision in the manifests.
- [x] Update the report and completed checklist, check the final diff, and commit the verified evidence before pushing the branch and creating the requested PR against the verified fork point.
