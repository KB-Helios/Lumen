# High-refresh Lumen UI

The goal is tight, subtle motion with quick settling on 120 Hz and 240 Hz
displays. Keep the existing visual design, motion tokens, quiet selection
spring, native window sequencing, reduced motion, and service boundaries.

## Approach

Use the existing Motion, WAAPI, CSS, GSAP, and Lottie systems. Move ordinary
entrance/exit movement to direct `transform` animations so Motion can delegate
them to WAAPI. Keep layout projection where layout continuity requires it.
Animate the result capsule's full transform with the existing spring rather
than updating its style from a JavaScript spring every frame. Measure selected
rows including their virtualizer transforms and cancel interrupted movement.

Allow the tiny active Lottie mark to interpolate between its authored 60 fps
frames on every display frame. Preserve destruction when inactive and static
reduced-motion/forced-colors fallbacks. Keep animations event driven and release
completed animations. Do not add a fixed 120/240 Hz timer or permanent GPU layers.

Changing only browser flags cannot fix main-thread animation work. Replacing
the entire motion system would risk continuity and accessibility without
evidence of a need. The focused compositor changes preserve the current feel.

## Measurement

Keep direct input-handler timings and independently measure the next animation
frame after input. A requestAnimationFrame callback precedes presentation;
label this boundary accurately instead of calling handler duration paint time.
Report both strict 120 Hz (8.333 ms) and 240 Hz (4.167 ms) checks separately from
the existing cadence-aware release check. A strict pass requires observed frame
cadence as well as fast interaction work. Record Edge's GPU feature status,
device, viewport, screen, and headed/headless mode. Preserve raw measurements.

Refresh diagnostics remain on demand, with no React renders on every frame.
Discard the first partial frame, support refresh rates above 360 Hz, report
unmeasured cadence honestly, and bound sampling if a window becomes hidden.

WebView2 retains its default accelerated rendering configuration. No GPU,
vsync, security, or power-management override is introduced. Browser GPU
evidence describes the tested Edge process; native WebView2 presentation must
be reported separately if it cannot be measured in this workspace.

## Acceptance

- Real Edge animations use transform/opacity WAAPI where suitable and settle
  without active animations or activity indicators.
- Capsule placement is correct for ordinary and transformed virtual rows;
  interrupted and reduced-motion selection lands on the current row.
- Unit tests cover high-refresh diagnostics and interpolation lifecycle;
  browser tests cover actual animation behavior and geometry.
- Typecheck, lint, all unit/component tests, all Edge e2e tests, and frontend
  production build pass. Regenerate all registered gallery states, six recordings,
  and performance profile, and document the measured limitations.
