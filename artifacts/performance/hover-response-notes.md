# Hover response evidence

The sampler and reduced-motion ResultRow correction are committed in `b8d502d39a927a6287710fe7f05ec835a026dea3`, based on `4d13d7b83f149b9dc88f4ae40aee67618a077bed`.

`profile-summary.json` was generated before that source commit, with its exact six-file source diff present in the working tree. Its embedded `gitSha` identifies the base, **not a clean-base measurement**. The gallery and recordings were generated after the source commit. Gallery generation also included the fresh-page-per-scenario capture-tool correction shipped with this evidence.

The profile uses installed Edge 155.0.4283.45 and the deterministic browser adapter. All 80 fresh hover transitions reached both the hover state and exact intended token color by the next sampled callback. Hover response and paired actual callback interval p95 were 9.300 ms; nominal rAF interval p95 was separately 12.000 ms. The raw sample records preserve both clocks and callback offsets.

Cadence-aware release checks passed. Strict nominal 240 Hz selection, hover, aggregate, and cadence eligibility remain **false**. Legacy `hoverToPaint` fields describe callback observation with independent computed-style readiness, not compositor paint or a production 240 FPS guarantee.

`hover-response-before.json` records ten real-pointer baseline transitions: state was absent at callback one, present with a transparent background at callback two, and the intended color appeared at callback three. `hover-response-after.json` records ten transitions after disabling the row transition under resolved reduced motion: the intended color appeared in every first post-render MessageChannel task. The first callback still precedes React's hover commit. These are DOM/computed-style observations, not screenshots of a compositor frame.

Validation: nine sampler/profile contract tests and twelve focused installed-Edge tests passed. Negative fixtures independently reject missing or late state/style; tests also cover real pointer feedback and resolved system reduced motion while retaining normal transitions. Full release/native validation belongs to the final controller gate.

Gallery capture initially failed with Edge `net::ERR_INSUFFICIENT_RESOURCES` while reusing one page across the gallery, including after adequate disk space was verified. The capture tool now creates and closes each scenario page in `finally`, with the same context, options and assertions. The complete 57-state gallery then succeeded. No scenario retries or weaker assertions were introduced.
