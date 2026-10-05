# Windows AI integration preflight

Date: 2026-10-04

Branch: `codex/windows-ai-integrations`

Code baseline: `e0012c7`; design commit: `c1a3fdf`.

The user approved previews with availability checks and the native bridge approach. The written specification is still awaiting its required review. No Windows integration source code has been added yet. This report records the existing application's baseline so the subsequent implementation can distinguish new failures from existing ones.

## Dependency restoration

The initial `bun run typecheck` could not find `tsc` because this worktree had no installed dependencies. `bun install --frozen-lockfile` completed successfully with Bun 1.3.14 and installed 679 packages. It did not update `bun.lock` or application source.

## Verification results

| Command | Observed result |
| --- | --- |
| `bun run typecheck` | Passed after dependency restoration. |
| `bun run lint` | Passed with the repository's zero-warning requirement. |
| `bun run test` | Failed: 43 files passed, one file failed; 297 tests passed, one failed. |
| `bun run test:e2e` | Passed: 37 tests, installed Microsoft Edge, one worker, no retries, approximately 1.8 minutes. |

End-to-end coverage included search/selection/preview, keyboard and IME behavior, Computer Use safety controls, settings navigation and focus restoration, 200-percent text scaling, theme/gallery states, virtualization, and browser performance checks. Port 1420 had no listener when checked before the run.

No native source changed, and `bun run tauri build` was not run as part of this preflight. These results establish the existing frontend baseline; they do not establish Windows AI, Aion, ODR registration, or package identity activation.

## Existing unit-test failure

The failing test is `ActivityIndicator > creates a Lottie animation for an active non-reduced-motion indicator and destroys it on unmount` in `src/design-system/animations/ActivityIndicator.test.tsx`, at the assertion on line 157.

Reproduction:

- Running that test alone passed: one passed, six skipped.
- Running its entire file failed: six passed, one failed, with the same missing `data-activity-running` element as the full suite.

The preceding performance-setup failure test installs a throwing implementation on `animation.setSubframe`. The next test's `beforeEach` uses `vi.clearAllMocks`, which clears call history but retains that implementation, and does not reinitialize `setSubframe`. The component correctly falls back to its static mark, making the next test's active-animation expectation fail. The fixture must restore the default mock implementation before each test when implementation work begins. This is an existing test-isolation issue, not evidence of a Windows integration regression.

The behavior was verified against the [current Vitest mock documentation](https://github.com/vitest-dev/vitest/blob/main/docs/api/mock.md) fetched through Context7. Git blame also confirms that the affected fixture predates this integration branch.

## Native prerequisite observations

The earlier research turn inspected this host and found:

- Windows 11 Pro, version 10.0.26300.
- x64 AMD Ryzen AI 9 HX 370 with Radeon 890M.
- .NET SDKs 10.0.300 and 10.0.302.
- Installed x64 Windows App Runtimes 1.8 and 2.
- No `odr.exe` resolved through command lookup.

These observations are not substitutes for live API readiness probes. In particular, the current ARM64-only native Aion preview cannot run on this x64 host, and missing ODR in command lookup does not establish every possible Windows-owned installation location.

The official Aion sample currently publishes release `v1.0.0.0`, with a 33,969-byte SDK NuGet asset and a 1,387,233,639-byte ARM64 framework MSIX. The release API supplies SHA-256 digests. Implementation should pin those identities and digests instead of following a mutable latest release or executing upstream bootstrap scripts.

## Next action

After written-spec approval, write the implementation plan, restore the affected unit-test fixture, and implement each integration slice with the required regression and live acceptance evidence. The overall integration goal remains incomplete.
