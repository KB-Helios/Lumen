# DPI and responsive validation report

## UI refinement update, 2026-10-11

The Task 5 installed-Edge matrix passed with all eleven settings pages and four onboarding scenes at 100/125/150/175/200% text scales in dark/light/opaque/reduced-effects/reduced-motion/forced-colors contexts. It covers Rust's logical default/minimum/maximum bounds: collapsed 700 × 66 / 620 × 66 / 760 × 66; expanded 800 × 540 / 720 × 320 / 960 × 600; onboarding 800 × 600 / 720 × 560 / 960 × 720; settings 880 × 600 / 760 × 520 / 1080 × 760; gallery 1120 × 760 / 880 × 640 / 1440 × 960; plus 520 × 340 stress layouts and provider dialogs. Required controls stay contained and reachable, horizontal overflow stays <=1 px and focus restores after dialogs. Keyboard selection scrolls the latest target into view without moving query focus, including 10,000-result virtual collections.

These are simulated Edge renderer dimensions and CSS text scales. Production descendants use the assigned viewport after removing only the DEV browser host's default-size cap; child layouts and native Rust dimensions are unchanged. They do not prove all native Windows display/text scales, physical mixed-DPI transitions or attached 4K/ultrawide panels. Final root Edge records 130 pass/1 performance fail/2 did not run; two later separate passes do not make that full suite pass.

The current identifier-isolated release fixture at source `f0e6b6e` observes WebView2 154.0.4258.62, DPR 1.5, settings 880 × 600 and launcher 700 × 66 logical pixels without horizontal overflow. Three rapid Enter/Escape reversals retain input DOM/caret and settle at collapsed bounds. This is actual bounded native geometry evidence, separate from the browser matrix and normal installed-package startup smoke; it does not validate a complete physical DPI matrix.

The host has one 2560 × 1600 display independently verified at 240 Hz. Native callback p95 is 4.3 ms over 120 intervals, exceeding strict 4.1667 ms; compositor presentation remains Not measured. Actual 60 Hz capture is unperformed: CDS_TEST validates 60/original modes, but watchdog Job Object isolation fails before display mutation. 120/144/165 Hz are unavailable at this resolution; final readback remains the original 240 Hz. Mixed-DPI/multi-monitor transitions remain unverified. Final raw evidence and limits are in the [dated UI completion report](2026-10-11-ui-completion-motion.md) and [native fixture summary](../../artifacts/verification/ui-completion-motion/native-ui-acceptance-summary.json); the 150% native smoke below remains historical evidence.

## Historical phase-one snapshot

**Date:** 2026-07-31  
**Native host:** 2560 × 1440 physical, 1707 × 960 logical, 150 percent scale, 1707 × 912 work area with bottom taskbar  
**Result:** Automated logical-pixel/text-scale matrix and native 150 percent smoke check passed.

## Automated matrix

`tests/e2e/dpi-responsive.spec.ts` renders the production launcher geometry at four logical viewports and five text scales:

| Logical viewport | Intended coverage |
| --- | --- |
| 720 × 540 | Minimum expanded launcher / 1080p-class work area |
| 960 × 640 | 1440p-class logical work area |
| 1280 × 720 | 4K-class scaled work area |
| 1440 × 640 | Ultrawide geometry |

Each viewport is checked at 100, 125, 150, 175, and 200 percent text scale. The suite asserts that the launcher remains inside both axes and that neither the document nor root element develops horizontal or vertical overflow. At 720 pixels wide, preview hides before result capacity is reduced; at 960 pixels it is present. AgentGateway settings remain reachable and operable at 200 percent text size.

The Rust window tests independently verify collapsed and expanded logical dimensions, maximum workspace height, upper-fifth placement, and physical/logical conversion at non-unit scale factors.

## Native 150 percent check

The release executable was run on the single 150 percent display. The following surfaces were visually and interactively checked:

- 800 × 600 onboarding and native folder picker return;
- 700 × 66 collapsed launcher;
- 800 × 540 expanded real-file result and preview;
- file-details overlay;
- active-monitor placement below the top work-area edge;
- taskbar avoidance and clean hide/reopen through `Alt+Space`.

Text, icons, focus rings, dividers, window radius, result columns, preview scrollbar, and action bar remained crisp and bounded. The app displayed logical geometry rather than bitmap-scaled screenshots.

## Evidence

- `tests/e2e/dpi-responsive.spec.ts`
- `src-tauri/src/window.rs` tests
- `artifacts/screenshots/expanded-results.png`
- `artifacts/screenshots/settings-agent-gateway.png`
- `artifacts/screenshots/long-filename.png`
- `artifacts/screenshots/contact-sheet.png`

## Manual limits

Only one physical monitor was connected. The host could not provide a true multi-monitor or mixed-DPI transition, taskbars on alternate edges, or native 100/125/175/200 percent display modes. Those cases are covered by logical viewport/text-scale automation and window-geometry unit tests, but must be repeated on physical mixed-DPI hardware before public release. The 4K and ultrawide rows describe simulated logical work areas, not attached panels.
