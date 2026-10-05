# Lumen motion system

Lumen uses motion to preserve spatial continuity and confirm actions. It does not animate for decoration. Native window geometry changes only when the product crosses a mode boundary (`collapsed`, `expanded`, `onboarding`, `settings`, or `gallery`); continuous interaction stays inside the already-sized window.

For the launcher, native and web ordering is explicit: Rust/window services allocate expanded bounds before the inner workspace becomes visible; on collapse, the inner workspace dismisses before the native window returns to pill bounds. AI generation begins only after an explicit composer submission, and streamed deltas update one stable answer region rather than reconstructing the surface.

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
- The result capsule measures only the selected mounted row. Initial measurement uses the viewport ref or the capsule's parent while that ref attaches; a collection observer catches late mounts. Row rectangles include virtual-row transforms and scroll offsets. A resize observer and an inline-style observer catch selected-row geometry changes. An unmounted selected row hides the capsule until that row returns. The capsule snaps to its first measured position; subsequent movement uses Motion's mini native WAAPI spring with the shared quiet spring tokens and a full `transform` string. Selection attributes update immediately, while geometry reads and retargeting coalesce into one requested animation frame. Interruption commits the current native style; reduced motion and environments without native animation snap directly. Cleanup cancels pending frames, disconnects observers, and stops movement.
- When a refined result set replaces the current one, rows fade in through a short WAAPI cascade (140 ms, 14 ms stagger, capped at eight rows, opacity only). The first result set never cascades—it arrives together with the workspace reveal—nor do virtualized grids, so scrolling can never replay the effect.
- Preview changes use short opacity and horizontal transforms; stale preview requests are aborted and cannot animate back into view.
- Preview loading shows a static skeleton crossed by one transform-based shimmer sweep; the sweep never renders under reduced motion.
- The details dialog (React Aria `ModalOverlay`/`Modal`) animates through the Tailwind CSS-first `global.css` keyframes driven by the `data-entering`/`data-exiting` attributes: the overlay fades (160/120 ms) while the dialog rises and settles from a slight scale (190 ms in, 120 ms out). React Aria waits for these animations before unmounting.
- Settings confirmation dialogs reuse the details choreography; select popovers enter over 120 ms and exit over 120 ms. Shared CSS duration variables mirror the motion tokens. The owned palette alone animates workspace reveal, and settings expose the newly selected accessible panel immediately with one 210 ms content entrance.
- Onboarding scenes slide in the direction of travel: forward moves enter from the right and exit left, backward moves the reverse, resolved through `AnimatePresence custom` so exits use the latest direction.
- The launcher activity indicator is active only while file search, Computer Use, or an AI answer is running; it is static in every idle, ready, or paused state.
- Opening a file briefly confirms the selected row before the window is hidden.
- Large lists use compositor transforms from TanStack Virtual. React state is never updated per animation frame.

The compact launcher activity mark is the only Lottie/GSAP-owned motion path. A local, monochrome three-dot Lottie SVG loops only while file search, Computer Use, or an AI answer is active. Subframe interpolation follows the display's animation frames rather than stepping only at the artwork's authored 60 fps. GSAP scopes one transform/opacity settle transition to that mark and reverts it on state changes and unmount. Reduced motion uses the resting frame, forced colors use the static mark, and every other Lumen transition remains owned by Motion, WAAPI, React Aria, or CSS as described above.

## Reduced motion

Windows and application preferences resolve into one motion setting. Reduced motion makes layout movement immediate and retains at most an 80 ms opacity transition so state changes remain legible. Persistent loading shimmer is disabled. The same geometry, focus order, announcements, and action timing remain available.

Reduced motion is enforced on three levels: `MotionConfig reducedMotion="always"` plus explicit flags for Motion components, a global CSS rule (`[data-reduced-motion='true']`) that collapses every CSS animation and transition to 1 ms—including the dialog keyframes—and token-driven durations that components read through `useLumenMotion()`.

## Performance constraints

Only `opacity` and `transform` are used for continuous visual movement. Blur and noise are static material properties, pointer movement is not bound to React renders, and no idle animation loop is allowed (the searching pulse and loading shimmer run only while work is actually in flight). Performance reports must name the tested hardware, display refresh rate, and measurement method; Lumen does not claim a fixed 240 FPS result without measurement.

Ordinary reveal, preview, settings, onboarding, and shimmer movement uses full transform strings so Motion can delegate suitable animations to WAAPI. Scope/filter layout projection remains owned by Motion. No fixed 60/120/240 Hz timer or blanket permanent layer promotion is added. Refresh diagnostics start unmeasured, sample complete intervals on demand, and cancel hidden or stalled sampling without per-frame React updates. Input handler duration and the next animation-frame callback are separate metrics; callbacks precede physical presentation. The profiler reports both cadence-aware release budgets and strict 120/240 Hz targets, including misses.

WebView2 keeps its default GPU-enabled configuration. Lumen adds no browser flag that disables GPU rendering; transform/opacity movement is compositor-eligible, but reports do not claim that hardware compositing is available when Windows, WebView2, a graphics driver, policy, or a remote session selects software fallback.
