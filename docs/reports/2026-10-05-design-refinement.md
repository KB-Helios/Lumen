# Lumen design refinement validation

Completed on 2026-10-05 against source commit `23d206dc9b00e6f9b4126e98bcaca51ed13fdd92` on `codex/design-theme-layout-motion`. The source baseline was `61d9164`.

The [approved design](../superpowers/specs/2026-10-05-lumen-design-refinement.md) and [implementation plan](../superpowers/plans/2026-10-05-lumen-design-refinement.md) are implemented. This is a refinement of the existing product surfaces and motion contract.

## Changes and observed results

| Area | Result |
| --- | --- |
| Theme and materials | Launcher, settings, and onboarding share graphite/off-white semantic surfaces, readable text roles, neutral hover/selection fills, and the existing teal accent. Decorative glow, noise, and specular layers are quieter. Status colors remain meaningful. |
| Constrained results and answers | The 520 x 340 streaming-answer scenario improved from a zero-height results viewport to **70px** at normal text size. Its inner workspace is 172px high with no vertical overflow at that scale. Answer text scrolls separately; enlarged content can scroll inside the workspace while actions and status remain anchored. |
| Preview and metadata | Preview eligibility uses actual workspace dimensions: automatic at the normal 800px width, always at 760px, both with 220px of usable height and allowance for the two border pixels. Short/narrow workspaces yield preview before results. Metadata responds to the result column, leaving filename/path room beside preview. |
| Primary actions and typography | Recording inspection exposed a late CSS reset overriding authored control font/color utilities. Moving form-control resets into Tailwind's base layer restores the intended type and semantic foreground. A browser regression verifies the actual foreground, 14px medium-button type, and contrast of at least 4.5 in both light and dark modes. |
| Result selection | The capsule appears at the initial selection, follows transformed virtual rows, and hides while its selected row is unmounted. Row selection updates immediately; capsule geometry reads are combined before paint. Cleanup cancels queued work and observers. |
| Settings | Labels wrap inside a bounded, independently scrolling rail. Narrow content stacks labels and controls, bounds fields/popovers, and wraps route/provider/consent actions. One accessible active panel enters briefly; page changes reset scrolling and retain navigation focus. |
| Onboarding and Computer Use | Scene/content regions scroll independently within stable chrome. Onboarding preserves its primary action and directional transitions. Browser-agent presentation retains approval, denial, cancellation, and keyboard order. |
| Motion | Shared hover/press/selection/open/page durations replace scattered timings. The palette owns workspace reveal. Confirmation overlays reuse details choreography; reduced motion and active-only activity animation remain intact. |

Before/after audit captures are in [the design audit directory](../../artifacts/design-audit/2026-10-05). The focused comparisons are [constrained results before](../../artifacts/design-audit/2026-10-05/constrained-results.png), [after](../../artifacts/design-audit/2026-10-05/constrained-results-after.png), [settings at 200% before](../../artifacts/design-audit/2026-10-05/settings-text-200.png), and [after](../../artifacts/design-audit/2026-10-05/settings-text-200-after.png). The [light primary action](../../artifacts/design-audit/2026-10-05/light-primary-after.png) confirms the corrected foreground.

## Fresh verification

The final source passed the repository checks in order. Follow-up source fixes were followed by fresh verification, rather than relying on earlier runs.

| Command | Result |
| --- | --- |
| `rtk bun run typecheck` | Passed |
| `rtk bun run lint` | Passed, zero warnings |
| `rtk bun run test` | 51 files, 373 tests passed |
| `rtk bun run test:e2e` | 51 tests passed in Microsoft Edge, serial with no retries |
| `rtk bun run build` | Passed |
| `rtk bun run capture:gallery` | All 57 current registry states and contact sheet regenerated |
| `rtk bun run record:interactions` | All six interaction studies regenerated |
| `rtk bun run profile` | All cadence-aware release checks passed |
| `rtk git diff --check` | Passed |

Coverage includes four logical viewport sizes at 100%, 125%, 150%, 175%, and 200% text; usable result/answer scroll viewports in the constrained scenario; all ten settings pages in 520 x 340 at every text scale; onboarding scene progression at the native 720 x 560 minimum and 520 x 340 across every scale; keyboard search, selection, details, scope navigation, settings focus restoration, and Computer Use safety actions. Theme, opaque, high-contrast, and reduced-motion checks remain passing. The 10,000-result fixture remains virtualized.

Independent source review and follow-up reviews found no unresolved material issue. Review findings concerning selection placement, high-contrast foreground verification, and waiting for the onboarding shortcut scene were addressed and verified.

No native, service, state, platform, dependency, or lockfile changes were made. Native window geometry, credentials, consent, confined search, process ownership, and typed service boundaries retain their existing owners. A native release build was not required for this frontend-only change.

The build retains the existing `lottie-web` direct-eval warning; unit tests retain jsdom's canvas-context diagnostic. Both commands exited successfully.

## Evidence inspection

[Screenshot manifest](../../artifacts/screenshots/manifest.json), [contact sheet](../../artifacts/screenshots/contact-sheet.png), [recording manifest](../../artifacts/recordings/manifest.json), and [performance summary](../../artifacts/performance/profile-summary.json) identify the same final source commit. Capture waits for the intended completed/loading/error preview state and settled presentation before writing each image.

The complete contact sheet and representative dark, light, opaque, high-contrast, constrained, preview, settings, and onboarding images were inspected. All six WebM files decoded into sample frames retained in the design audit directory; representative launcher, settings, onboarding, answer, approval, and activity frames were inspected. Recordings exercise deterministic adapters and contain no audio.

## Performance and limits

The final profile used Microsoft Edge 154.0.4258.53 on Windows 11 Pro build 26300, an AMD Ryzen AI 9 HX 370, and Radeon 890M graphics (driver 32.0.31041.1004). Windows reports 240Hz for the Radeon display and also exposes a USB virtual-display adapter whose refresh rate is unavailable. The measured browser cadence is authoritative for these checks.

The warm, deterministic 800 x 540 browser run sampled 30 paced inputs, 120 paced selections, 80 paired hover/frame measurements, synchronous 30-event input/selection bursts, and settled activity/idle behavior. It measured a 4.2ms median frame interval (about 238Hz), 4.3ms p95 cadence, a 6.3ms effective input/selection budget including scheduling tolerance, and a 10.1ms contemporaneous hover budget.

| Measurement | Final result |
| --- | ---: |
| Warm launcher p95 | 3.6ms |
| Input response p95 | 0.1ms |
| Selection to paint p95 | 4.7ms |
| Hover to paint p95 | 6.7ms |
| 30-event input burst, synchronous | 1.5ms |
| 30-event selection burst, synchronous | 2.4ms |
| Sampled browser long tasks over 50ms | 0 |
| Animations / active indicators after settle | 0 / 0 |
| Idle CPU during the sample | 0.43% |
| JavaScript heap after collection | 29.77MiB |

Cadence-aware checks passed; strict 240Hz cadence and strict 4.167ms selection/hover checks did **not** pass. These are browser frontend measurements with deterministic data, not native WebView2/material verification or provider/backend latency measurements. Native window visuals, Acrylic/Mica behavior, and packaged runtime behavior were not visually verified in this task.
