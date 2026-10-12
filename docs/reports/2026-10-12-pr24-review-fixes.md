# PR #24 review fixes

Runtime source: `cae7d92ad3946ebdd5008ba84d8eb84db8d340f7`. All eight actionable review findings were verified and fixed. Automated review availability/billing notices were not product defects.

| Review | Result |
| --- | --- |
| [Additive removal](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4244177306) | Journal the live file and private ownership snapshot together. Restore prior values only where managed fields are unchanged; preserve user additions and edits. |
| [Root persistence](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4244177310) | Roll back the persisted removal on rejected native admission. A failed rollback reflects the committed removal without discarding newer queued root additions. |
| [Glass hydration](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4244177315) | Read/apply glass intensity only after settings hydration. |
| [Codex preset](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4244177320) | Use `https://api.openai.com/v1`. |
| [Exclusive removal](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4250095486) | Compare current connection fields with the applied ownership hash. External connection edits disable removal; saved profile edits retain ownership of the previous activation. |
| [Obsolete additive models](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4250095499) | Undo the previous managed model before merging the edited profile; retain pre-existing and user-enriched models. |
| [OpenClaw schema](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4250095504) | Write `baseUrl`, `apiKey`, and a nonempty model `name`. Preserve model identity/name when retaining user-enriched entries. |
| [Export cancellation](https://github.com/KB-Helios/Lumen/pull/24#discussion_r4250095511) | Dismiss confirmation normally when the native save picker is cancelled. |

The compatibility changes follow the [Codex provider example](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [OpenClaw custom-provider documentation](https://docs.openclaw.ai/gateway/config-tools/custom-providers), and [OpenClaw model schema](https://github.com/openclaw/openclaw/blob/main/src/config/zod-schema.core.ts). Ownership snapshots remain native, bounded, and excluded from profile responses and diagnostics. Older additive activations without ownership evidence cannot be removed automatically; reactivation conservatively treats existing fields as user-owned.

## Verification

| Gate | Result |
| --- | --- |
| Typecheck / lint | Pass; zero ESLint warnings |
| Vitest | 708 passed across 83 files with two workers; assertions and time limits unchanged |
| Rust formatting / Clippy | Pass; warnings denied |
| Rust all-features tests | 312 passed; 16 existing acceptance tests ignored; serial execution |
| Native answer bridge | 7 passed |
| Evidence generator / budget contracts | 15 passed |
| Sidecar staging | Pass after independently rechecking generated/staged bytes and source/package health following the initial worker health timeout |
| Full Edge suite | 130 passed, 1 failed, 2 did not run; 35.6 minutes |
| Release/NSIS build | Pass; full `bun run tauri build`, including staging and frontend build |
| Gallery / recordings | 86 states and six studies regenerated against the runtime source commit |
| Remaining Edge cases | Both previously unreached cases passed in a separate focused run |
| Final performance profile after packaging | Failed: ordinary React p95 16.6 ms, three ordinary-query Long Tasks (50/59/51 ms), strict 240 Hz failed; failed data retained in `artifacts/performance/profile-summary.json` |

The full Edge failure is the existing ordinary React commit gate: p95 11.3 ms exceeds the unchanged 3 ms limit. The previously committed full run also failed that gate. CI previously stopped after 15 minutes before reaching the performance assertion. The Edge step now allows 45 minutes, and the complete packaging job allows 120 minutes; test assertions, per-test timeouts, serial Edge execution, and frame budgets are unchanged.

The final profile ran after the build/installer process exited. It supersedes an earlier sample taken during installer compression. Its observed refresh estimate is 238 Hz, while callback p95 is 12.5 ms; cadence eligibility for strict 240 Hz remains false. Passing paired-frame hover checks does not imply strict 240 Hz acceptance. The full Edge run and the two remaining cases are separate runs, not one fully passing suite.

Installer output: `Lumen_0.1.0_x64-setup.exe`, 203,101,102 bytes, SHA-256 `089db0bde30a8faa3b89c7bda2a001a0f86ecb6b2a335799f37f2374d9ffe3df`. Building this installer does not prove installation, signing, or live provider behavior.

These fixes do not close the broader performance, live-provider, installer/signing, or manual accessibility acceptance documented in the earlier UI completion report. Ignored acceptance tests are not passes.
