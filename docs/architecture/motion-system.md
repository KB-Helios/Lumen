# Lumen motion system

Lumen uses motion to preserve spatial continuity and confirm actions. It does not animate for decoration. Native window geometry changes only when the product crosses a mode boundary (`collapsed`, `expanded`, `onboarding`, `settings`, or `gallery`); continuous interaction stays inside the already-sized window.

For the launcher, native and web ordering is explicit: Rust/window services allocate expanded bounds before the inner workspace becomes visible; on collapse, the workspace and footer remain mounted for their exit, then notify the presentation hook before Rust returns the window to pill bounds. Typing during exit cancels obsolete completion through a generation fence. The uncontrolled search input stays mounted, preserving DOM identity, caret and IME composition. AI generation begins only after an explicit composer submission, and streamed deltas update one stable answer region rather than reconstructing the surface. Native Stop, cancellation and approval never wait for animation.

## Timing tokens

| Token | Duration | Use |
| --- | ---: | --- |
| Hover | 90 ms | Color, border, and quiet luminosity response |
| Press | 72 ms | Tactile control and result-open confirmation |
| Selection | 120 ms | Non-spring selection color changes, filter-chip and empty-state fades |
| Launcher open | 160 ms | Internal opacity and slight upward settle; details-overlay fade-in |
| Launcher close | 120 ms | Internal exit opacity; details-overlay and dialog exit |
| Launcher expansion | 190 ms | Internal region reveal after the native resize request; details-dialog content entry |
| Preview | 160 ms | Preview content replacement and details entry |
| Page | 210 ms | Onboarding and management-page movement |

The standard easing curve is `cubic-bezier(0.2, 0.8, 0.2, 1)`. Exits use `cubic-bezier(0.4, 0, 1, 1)`. Moving selection and scope geometry uses one shared spring (damping ratio ≈ 0.96: a quiet, tactile snap without visible overshoot):

```text
type: spring
stiffness: 560
damping: 38
mass: 0.7
```

## Spatial rules

- The search input remains anchored while the workspace appears beneath it.
- The active scope indicator uses the shared `lumen-scope-indicator` layout identity.
- The result capsule uses Motion's native mini/WAAPI path with complete transform strings and measures only the selected mounted row. Virtual row rectangles include their translated position. Initial placement snaps; subsequent moves use the shared spring, retargeting from the visible position. Geometry reads coalesce into one animation-frame callback. The observer for an unchanged selected node is retained so initial ResizeObserver notifications cannot form a re-observation loop. Hidden/native-invisible/unmounted surfaces cancel frames and animations and disconnect observers; showing reconnects and snaps the latest selection. An unmounted selected row hides the capsule until it returns.
- Selection attributes update synchronously. Keyboard scrolling coalesces to the latest intent once per frame, uses virtualizer index scrolling for unmounted targets, and preserves input focus. Indexed collection lookups avoid scanning 10,000 rows per key. Replacement collections reset React Aria selection/focus state while retaining the input, viewport and capsule.
- Each result-set identity owns one bounded WAAPI opacity cascade (140 ms, 14 ms stagger, capped at eight mounted rows). This includes initially mounted virtual rows; virtual scrolling and motion-policy changes cannot replay a consumed cascade. Replacement/unmount cancels pending frames and animations.
- Preview changes use short opacity and horizontal transforms; stale preview requests are aborted and cannot animate back into view.
- Preview loading shows a static skeleton crossed by one transform-based shimmer sweep; the sweep never renders under reduced motion.
- The details dialog (React Aria `ModalOverlay`/`Modal`) animates through the Tailwind CSS-first `global.css` keyframes driven by the `data-entering`/`data-exiting` attributes: the overlay fades (160/120 ms) while the dialog rises and settles from a slight scale (190 ms in, 120 ms out). React Aria waits for these animations before unmounting.
- Settings confirmation dialogs reuse the details choreography; select popovers enter over 120 ms and exit over 120 ms. Shared CSS duration variables mirror the motion tokens. The owned palette alone animates workspace reveal, and settings expose the newly selected accessible panel immediately with one 210 ms content entrance.
- Onboarding scenes slide in the direction of travel: forward moves enter from the right and exit left, backward moves the reverse, resolved through `AnimatePresence custom` so exits use the latest direction.
- The launcher activity indicator is active only while file search, Computer Use, or an AI answer is running; it is static in every idle, ready, or paused state.
- Opening a file briefly confirms the selected row before the window is hidden.
- Large lists use compositor transforms from TanStack Virtual. React state is never updated per animation frame.

The compact launcher activity mark is the only Lottie/GSAP-owned motion path. A local, monochrome three-dot Lottie SVG loops only while work is active, the launcher is visible and the document is visible. Lottie interpolates subframes at display cadence. GSAP owns only the wrapper's brief transform/opacity entrance and reverts its context on state changes/unmount; Lottie owns only the inner SVG and destroys its instance on cleanup. Reduced motion, forced colors and load failures use a static mark. Other transitions stay with the owners above; no property is driven by two systems.

## Reduced motion

One System/Full/Reduced setting resolves the motion policy. System follows Windows/browser media changes; Full requests full motion; Reduced makes layout movement immediate and retains at most an 80 ms opacity transition so state changes remain legible. The preview's single shimmer sweep is disabled. The same geometry, focus order, announcements, and action timing remain available.

Reduced motion is enforced by `MotionConfig`, explicit component flags and token-driven durations from `useLumenMotion()`. CSS suppresses cosmetic translate/scale and gives React Aria overlays opacity-only keyframes of at most 80 ms. It does not clear functional transforms needed by virtualized rows or slider geometry.

## Performance constraints

Only `opacity` and `transform` are used for continuous visual movement; structural radius snaps. Blur, shadow and noise are static material properties, pointer movement is not bound to React renders, and no idle animation/measurement loop is allowed. Preview shimmer is one bounded sweep, while the active-work mark runs only under its visibility gates. No permanent `will-change`, shader integration, new animation framework or dependency is introduced. Performance reports must name the tested hardware, display refresh rate and measurement method; Lumen does not claim a fixed 240 FPS result without measurement.

Developer diagnostics distinguish synchronous input handling from input-to-next-rAF callback, meaningful ordinary React commits from imperative row painting, and strict 120/240 Hz budgets from cadence-aware checks. Refresh estimation needs 60 complete positive intervals and stops on hiding, timeout or unmount; missing measurements stay unavailable rather than defaulting to 60 Hz or zero. Timed browser runs exclude tracing and screenshots; trace studies run separately. Callback timing and browser GPU status do not prove native compositor presentation.

WebView2 keeps its default GPU-enabled configuration. Lumen adds no browser flag that disables GPU rendering; transform/opacity movement is compositor-eligible, but reports do not claim that hardware compositing is available when Windows, WebView2, a graphics driver, policy, or a remote session selects software fallback.
