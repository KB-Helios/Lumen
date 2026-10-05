# Lumen design, layout, and motion refinement

Status: approved by the user on 2026-10-05. Implementation in progress.

## Direction

Refine the existing keyboard-first Windows launcher around readable graphite and off-white surfaces, one restrained teal accent, clear hierarchy, and brief motion that confirms an action. Improve the existing launcher, results, previews, answers, settings, onboarding, and browser-agent presentation through the shared design system.

The recommendation is a coordinated refinement. A token-only polish would improve color consistency but leave the measured layout failures. A new visual identity would cost more and discard established interaction patterns. The coordinated refinement addresses both appearance and usability while retaining the product's current character.

## Audit and evidence

Reviewed the shared theme, surface and control primitives, launcher composition, results, previews, answers, settings pages, onboarding, gallery registry, animation ownership, and checked-in visual/performance evidence. The source baseline is commit `61d9164`. Live observations used this checkout's Vite server and the Codex browser; automated acceptance uses Microsoft Edge as required by the repository.

| Finding | Evidence and cause | Improvement |
| --- | --- | --- |
| The dark launcher is substantially lighter than settings, with weak metadata hierarchy. | `global.css:312` uses a white translucent launcher surface and 50% white muted text rather than the shared dark semantic roles. The dark gallery and live launcher reproduce the bright gray surface. | Bind the owned palette to semantic surface, text, border, and interaction tokens in both themes; reduce additive white/specular layers and the logo glow. |
| Local results disappear when an answer is displayed in a short window. | In the settled `constrained-work-area` scenario at a 960 x 640 browser viewport, the 520 x 340 launcher has a result scroll viewport with **zero client height**. `AnswerPanel.tsx:62` imposes a 150px minimum, while the composer, scopes, actions, and footer consume the remaining height. | Give answers and results explicit, bounded allocations with independent scrolling; keep at least one usable row visible within the supported constrained acceptance cases. |
| Preview eligibility depends on browser width rather than available launcher space. | `ExpandedWorkspace.tsx:252` reads window media queries. A 520px gallery launcher in a 960px browser still mounts a 280px preview; in the constrained case its height is zero. | Resolve preview from the actual workspace width and available height. Preview yields before results; details remain accessible by keyboard and action button. |
| The result list spends too much width on repeated metadata. | At a wide browser viewport, the 800px launcher splits into results and preview. Each result still reserves source, size, and an Enter hint according to window breakpoints. Filename and path are truncated despite available hierarchy options. | Make metadata responsive to the result column itself. Prioritize filename and path; retain source and size where they fit and show the Enter hint for the selected row when space allows. |
| Settings navigation clips at larger text sizes. | In the 880 x 600, 200% text gallery, the navigation is 244px wide with a 316px scroll width. Fixed rail geometry and rem-based padding crowd labels. | Use bounded rail geometry, wrapping labels, smaller stable padding, and vertical scrolling without sideways clipping. Preserve accessible names and arrow-key navigation. |
| Settings rows cannot adapt their label/control relationship. | `SettingRow.tsx:15` always uses two columns. Selects, sliders, URLs, route controls, and credential actions have fixed minimum widths. | Use a settings-content container breakpoint: side-by-side when both columns fit, stacked label and controls otherwise. Bound fields and popovers and allow action groups to wrap. |
| Settings page exits do not have a persistent presence boundary. | `SettingsShell.tsx:105` keys the `TabPanel` containing `AnimatePresence`, so changing pages unmounts the presence controller itself. | Use one accessible active panel with a brief content entrance. Keep navigation responsive and avoid adding delayed removal of interactive outgoing panels. |
| Motion and spacing vary across shared controls and dialogs. | Settings switches and navigation use local 150ms timings; confirmation dialogs lack the established details-dialog choreography. Workspace wrappers both animate their entrance. | Reuse the existing timing/easing contract, make one owner responsible for workspace reveal, and add consistent overlay/popover motion with reduced-motion handling. |
| Onboarding can clip its scene content when text grows. | The scene region is `overflow-hidden`, padding grows with text scale, and answer-choice content has a 360px minimum width. | Keep the header and primary action anchored, allow the scene to scroll, and bound its content to available width. Preserve directional scene transitions and completion behavior. |

Existing strengths to retain: semantic status colors, React Aria controls, live appearance preferences, portal theme inheritance, an opaque passive preview body, immediate keyboard selection, virtualized large result sets, explicit AI submission, native window-mode ordering, and the active-only Lottie/GSAP indicator.

Live audit captures: [constrained results](../../../artifacts/design-audit/2026-10-05/constrained-results.png) and [settings at 200% text](../../../artifacts/design-audit/2026-10-05/settings-text-200.png). The current gallery registry has 57 states; older documentation describing 53 states predates the Windows AI additions.

## Surface and type system

Use the existing graphite canvas (`#111110`) and off-white light canvas (`#f7f7f5`) as the palette anchors. Retain the teal accent (`#63c7af` dark, `#0f7a67` light). Launcher and management surfaces consume the same semantic roles; selected and hovered controls receive distinct neutral fills, with teal reserved for focus and intentional emphasis.

Increase useful secondary and tertiary text contrast and reduce decorative luminosity. Keep the 18px outer radius and 12px control radius. Use one outer shadow and a subtle inner edge; internal settings sections are separated by borders and spacing rather than stacked shadows. Passive previews keep an opaque canvas for wallpaper-independent legibility.

Keep Segoe UI, the established body/type scale, and density preferences. Use consistent gutters and align section headings with their content. Important descriptions use readable secondary text; very quiet text is reserved for supplementary metadata. Color must not be the sole indication of selection, errors, unavailable services, or approval state.

## Layout behavior

The composer stays anchored. Scope navigation may scroll horizontally; it never steals the results' height through wrapping. Results and answers share the inner workspace using bounded regions. In short windows, compact the answer header, its text viewport, and supplementary spacing before reducing results to an unusable area. Keep Stop, sources, Open, Details, and status reachable. For larger text that exceeds the simultaneous-view budget, provide inner scrolling while retaining access to both primary regions.

Inline preview requires sufficient workspace width and height. The `always` preference requests a preview within those constraints; it does not override containment. The automatic preference should show a useful preview at the normal 800px expanded width and omit it in narrow or short layouts. Result-column metadata responds to its own available width independently of preview eligibility. Long filenames, Unicode, and missing metadata preserve action alignment.

Settings retain the existing vertical navigation and independent page scroll region. Rows stack when labels and controls cannot fit. Text fields, route lists, provider rows, browser start-page controls, and consent action groups stay within their page container. Large text and the native minimum work area retain navigation labels, focus rings, and a visible close action. Onboarding and Computer Use follow the same gutter, containment, and scrolling rules.

## Motion behavior

Use the established 90ms hover, 72ms press, 120ms selection, 160ms preview/open, 190ms workspace reveal, and 210ms page tokens with the standard easing curve. Keep the quiet shared selection spring and immediate first placement. Only one wrapper animates workspace entry. Page content enters with a small offset and opacity; navigation state updates immediately. Do not wait for an outgoing page before exposing the selected page's accessible panel.

React Aria overlays and popovers use their entering/exiting attributes with short opacity and transform transitions. Onboarding retains direction-aware movement. Reduced motion removes spatial movement and retains at most an 80ms fade. Existing global reduced-motion and forced-colors rules continue to apply. No decorative idle loops, additional animation libraries, permanent `will-change`, or frame-by-frame React state are introduced.

## Implementation boundary

Primary owners are `src/design-system/global.css`, shared surface/control primitives, `ExpandedWorkspace`, `ResultRow`, `AnswerPanel`, `SettingsShell`, `SettingsNav`, `SettingRow`, settings control and gateway presentation components, and onboarding scene layout. Improve Computer Use layout where it shares the same containment issues. Keep state persistence, consent, credentials, service contracts, search ranking, native process ownership, and native window geometry under their existing owners.

## Acceptance and verification

1. Dark, light, opaque, high-contrast, reduced-effects, and reduced-motion modes keep consistent geometry and readable state hierarchy, including themed portals.
2. Native-size launcher/settings/onboarding layouts and the 520 x 340 constrained gallery remain usable at 100%, 125%, 150%, 175%, and 200% text scale. Tests assert nonzero usable scroll viewports, not just that a child is attached or has its own bounding box.
3. Keyboard-only search, scope changes, selection, preview/details, dialog dismissal, settings navigation, and focus restoration remain complete. Keep target heights at least 32 logical pixels.
4. Add focused behavioral regressions for the measured layout failures and responsive controls. Verify visual refinements through fresh captures rather than CSS-text snapshots alone.
5. Run typecheck, lint, unit/component tests, Edge e2e, and frontend production build after final source edits. A native release build is required if native files change.
6. Regenerate the full current gallery registry, six interaction recordings, and performance summary after implementation. Wait for the intended preview/answer state before capturing. Inspect representative output and retain explicit environment/cadence limits in the performance report.
7. Do not claim native WebView2 visuals, native material behavior, or a strict 240Hz result from browser-only evidence.

## Current baseline

- Typecheck passed.
- Lint passed with zero warnings.
- Unit/component tests passed: 51 files, 369 tests.
- Full Edge e2e baseline passed: 39 tests. Its containment checks did not detect the zero-height result viewport or sideways settings navigation.
- Implementation and regenerated post-change evidence are in progress.
