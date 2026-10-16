# Lumen native shell

Lumen runs in one persistent, borderless Tauri 2 window. Closing hides the window instead of destroying the webview, so search state remains warm. A second process redirects to the existing window. `Alt+Space` opens, positions, focuses, and asks the frontend to focus its search input.

## Window modes

| Mode | Baseline logical size | Constraints |
| --- | --- | --- |
| Collapsed | 700 × 66 | 620–760 wide, fixed height |
| Expanded | 800 × 540 | 720–960 wide, maximum 600 high |
| Onboarding | 800 × 600 | 720–960 wide |
| Settings | 880 × 600 | 760–1080 wide |
| Gallery | 1120 × 760 | 880–1440 wide |

Rust owns the geometry table. Placement reads the cursor's active monitor work area, converts logical size with that monitor's scale factor, centers horizontally, and places the launcher 18 percent into the remaining vertical space. Changing modes clears old constraints before applying the new size.

The React palette never owns or continuously animates those OS bounds. It requests expanded bounds first and reveals its clipped inner workspace only after that request resolves; it hides the inner workspace before requesting collapsed bounds. Within constrained bounds, the composer and compact footer stay stable while result and answer regions scroll internally and preview collapses before primary results.

## Material fallback

The collapsed launcher clears full-window native effects so the transparent window does not paint a rectangle outside its padded rounded pill; the desktop remains visible around it. Expanded, onboarding, settings, and gallery modes request Acrylic, then Mica, then Blur through Tauri's native effects list. The web surface always supplies adaptive tint, restrained luminosity, texture, edges, and shadow. If native composition is unavailable—or transparency is disabled—the opaque Tailwind CSS semantic theme remains complete and readable. The [2026-10-15 offline native fixture report](../reports/2026-10-15-launcher-native-appearance.md) records the owned composited capture and exact provenance; it does not establish ordinary-app, packaged, physical-display, or performance acceptance.

## Security and plugins

The `main` capability is Windows-only and scoped to one window. It grants the four Store operations used by appearance persistence and the Phase 1 log, folder-dialog, opener, and autostart APIs. Global-shortcut and positioner operations remain Rust-owned. The shell plugin is not installed, and no execute or spawn permission exists. Production and development CSPs allow only the local Tauri/Vite transport and app assets.

