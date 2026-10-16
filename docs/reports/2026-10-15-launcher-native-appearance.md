# Launcher native appearance verification

The rebuilt offline native fixture now provides actual composited evidence that collapsed padding and rounded corners reveal the controlled background. Initial collapsed, expanded-to-collapsed, and collapsed reopening retain the rounded dark pill. The original source material repair needed no further styling change. A separate debug-fixture hide defect prevented reopening verification; commit `911fa8546d57aba87d2e3ddff2169b928666c4ff` fixes only that fixture command. Nothing was pushed.

## Provenance and scope

- Starting HEAD: `b39d22263b3815928f3b8a30c5f4be76e19dada1`, branch `codex/production-readiness`.
- Final HEAD: `911fa8546d57aba87d2e3ddff2169b928666c4ff`, `fix: hide offline native fixture without activation`.
- Final source status: only the root-owned untracked `docs/superpowers/plans/2026-10-12-production-readiness.md`. The plan was neither changed nor staged.
- Native evidence at `2026-10-15T01:11:48.495Z` was captured on starting HEAD plus the exact tracked patch later committed. Tracked diff SHA256 was `3acb4c491373e7d1a47db8e7175adbe37055e20e8f6718516298ef207b6395a5`. The [committed evidence archive manifest](../../artifacts/native/launcher-appearance-2026-10-15/manifest.json) records exact byte counts and hashes for the raw evidence. [Capture provenance](../../artifacts/native/launcher-appearance-2026-10-15/provenance.json) records source/probe hashes and dirty status; [RED provenance](../../artifacts/native/launcher-appearance-2026-10-15/provenance-red.json) records the earlier clean source and failing executable. The exact [captured source patch](../../artifacts/native/launcher-appearance-2026-10-15/capture-source.patch) is archived separately from the clean starting HEAD.
- Final debug executable: `D:/CodexBuilds/Lumen/production-readiness/debug/lumen.exe`, SHA256 `c45dd0731cb30b39376b0c5cd9ed29da7e518dafa3a8d5cb3b967c359f4a4006`. Earlier rebuilt executable before the fixture hide repair: `c84882dc820a9c2a3c008fa83cce44edac3a8ea55abf13d1b17912680f456879`.
- Changed source SHA256, `src-tauri/src/native_performance.rs`: `4d755ed2ea31475122140771bb6369db3e915bdbbd4fce057855c2c32dfc9375`. Unchanged material policy `src-tauri/src/window.rs`: `4611ca88180c38237942f70d451a2053524d70ee46b5dfb3775c2e4e29d8f3cb`.
- Initial free space: C `111745839104` bytes, D `336156381184` bytes. Final readback: C `111357378560`, D `335882735616`. No claim about who changed capacity. A later transient CPU read was 82%; the native run still completed within the original bounded probe deadlines.

Only the early offline native fixture was launched, with a fresh admitted `lumen-native-performance-` child of Windows temp, its own WebView data, strict port 1420, and the existing native fixture HTML. No ordinary native App bootstrap, keyring, index, provider, shortcut/single-instance setup, Docker, performance profile, display/focus setting, unrelated process stop, signing, install, or grants were used. The browser alpha diagnostic used a fresh installed-Edge headless context and memory service. Browser evidence is separate from native pixels.

## Native capture admission and results

The archived [native probe](../../artifacts/native/launcher-appearance-2026-10-15/launcher-native-verify.mjs.txt) and [controlled-underlay probe](../../artifacts/native/launcher-appearance-2026-10-15/launcher-controlled-underlay.ps1.txt) preserve the source used. The latter sets its thread to per-monitor-v2 DPI awareness before HWND/geometry/underlay operations; validates exact fixture PID and StartTime; requires physical HWND dimensions equal the fixture status; and requires the underlay rectangle equal that rectangle. Before reading any pixels, it checks **every captured coordinate**: the topmost HWND's root must be the exact fixture or underlay HWND, and its PID must belong to the verified fixture process tree or exact underlay process. The CDP listener must belong to that tree, and its command line must name the newly owned data directory. See [pre-capture ownership](../../artifacts/native/launcher-appearance-2026-10-15/attachment-before.json) and [admitted capture ownership](../../artifacts/native/launcher-appearance-2026-10-15/attachment.json). The owned WebView child HWND is admitted through both the exact host root chain and owned browser process tree, never through a broad PID allowance.

The underlay is a task-owned solid, borderless nonactivating form placed behind the owned fixture. Capture is restricted to their exact common rectangle. The fixture and underlay check foreground identity before/after operations; native fixture monitoring samples every 50 ms. Final foreground HWND remained `197926`; every final native status reports `foregroundUnchanged: true`. No foreground restoration was attempted.

Sampling geometry is fixed in physical pixels: corner `(0,0)`, padding `(2,2)`, left `(2,height/2)`, right `(width-3,height/2)`, surface `(30,height/2)`. Cyan is RGB `(25,200,220)` and orange `(236,120,40)`. The pill's existing soft shadow intentionally darkens transparent padding, so exact equality with the underlay is **not** the acceptance condition; no existing numeric budget/assertion was relaxed. The controlled color change distinguishes transmitted background from an opaque full-HWND rectangle. Integer channel rounding and local shadow remain visible in the raw samples.

| State / underlay | Corner RGB | Padding RGB | Surface RGB | Physical bounds |
|---|---|---|---|---|
| Initial collapsed / cyan | 25,194,213 | 25,193,212 | 27,38,38 | x755 y257 1050x99 |
| Initial collapsed / orange | 229,117,40 | 228,116,39 | 40,33,27 | x755 y257 1050x99 |
| Expanded / cyan | 81,81,81 | 81,81,81 | 31,31,30 | x680 y129 1200x810 |
| Expanded-to-collapsed / cyan | 25,194,213 | 25,193,212 | 27,38,38 | x755 y257 1050x99 |
| Expanded-to-collapsed / orange | 229,117,40 | 228,116,39 | 40,33,27 | x755 y257 1050x99 |
| Collapsed reopened / cyan | 25,194,213 | 25,193,212 | 27,38,38 | x755 y257 1050x99 |

Corner changes transmit about 96% of the underlay channel changes; the pill transmits roughly 6%, consistent with its retained `rgba(28,28,27,0.94)` surface tint and local shadow. Initial and returned collapsed samples match exactly. The actual controlled screenshot shows a dark rounded pill surrounded by the cyan/orange field, with no opaque gray rectangle. Expanded retains its native gray material, as required. Computed pill radius remains `999px`, with logical bounds x6 y6 688x54 in the 700x66 collapsed window. At native scale factor 1.5 those window bounds are 1050x99 physical pixels; expanded remains 800x540 logical / 1200x810 physical. No geometry, material, CSS, drag, or focus policy was redesigned.

Owned PNGs and raw evidence, all under the [committed native evidence archive](../../artifacts/native/launcher-appearance-2026-10-15/manifest.json):

- [Initial collapsed / cyan](../../artifacts/native/launcher-appearance-2026-10-15/collapsed-initial-cyan.png) and [initial collapsed / orange](../../artifacts/native/launcher-appearance-2026-10-15/collapsed-initial-orange.png).
- [Expanded](../../artifacts/native/launcher-appearance-2026-10-15/expanded.png), [expanded-to-collapsed / cyan](../../artifacts/native/launcher-appearance-2026-10-15/expanded-to-collapsed-cyan.png), and [expanded-to-collapsed / orange](../../artifacts/native/launcher-appearance-2026-10-15/expanded-to-collapsed-orange.png).
- [Collapsed reopened](../../artifacts/native/launcher-appearance-2026-10-15/collapsed-reopened.png).
- [Raw captures](../../artifacts/native/launcher-appearance-2026-10-15/captures.json) contain the points, HWND/PID identities, bounds, native statuses/foreground samples, and computed styles for each capture.
- [Browser alpha PNG](../../artifacts/native/launcher-appearance-2026-10-15/browser-alpha.png) and [browser paint record](../../artifacts/native/launcher-appearance-2026-10-15/browser-paint.json) separately show transparent html/body/main, `color-scheme: light dark`, rounded pill and its nontransparent tint in installed Edge. Those are browser canvas evidence, not proof by themselves of native composition. Native evidence required no color-scheme change.

## Diagnosed fixture hide repair and behavioral RED/GREEN

Before this change, the fixture used raw `SetWindowPos(SWP_SHOWWINDOW | SWP_NOACTIVATE | ...)` to show without focus, but registered the production `window.hide()` command. Pinned Tao `0.35.3` source at `src/platform_impl/windows/window.rs:164` updates its cached VISIBLE flag in `set_visible`; `window_state.rs` around line 319 returns early when the old/new masked flags are equal. Raw show leaves Tao's cached visible flag false, so a later ordinary hide with false is elided.

Behavioral RED, before editing Rust: the actual SearchExperience Escape/controller path hid its frontend presentation while native fixture status stayed visible at four observations following successive awaited delays of 0, 50, 200 and 500 ms. These are delay values, not absolute observation timestamps: their approximate cumulative offsets are 0, 50, 250 and 750 ms, plus command and sampling overhead. A direct fixture `hide_lumen_window` invocation returned `{mode:null,source:"command",visible:false}`, but independent Win32 `IsWindowVisible` remained true. [RED samples](../../artifacts/native/launcher-appearance-2026-10-15/hide-red.json) and [RED provenance](../../artifacts/native/launcher-appearance-2026-10-15/provenance-red.json) retain this evidence. This was an actual native behavior failure, not compile-red. The temporary JS invoke-wrapper trace remained empty and was not used as evidence of the native cause.

The fix introduces a fixture-local `hide_lumen_window` using `SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER`, with the existing foreground checks, and registers it only in the offline builder. Production `src-tauri/src/window.rs::hide_lumen_window` is unchanged. It does not activate a window to synchronize Tao's cached state. The module is already gated to Windows debug builds.

GREEN used the same native probe, assertions, timeout values, source hash for the probe/underlay, and controlled colors. The rebuilt fixture reports false at the first observation following the 0 ms delay and at the remaining observations following successive delays of 50, 200 and 500 ms; independent Win32 readback is false. Reopening returns visible true with unchanged foreground and identical cyan corner/padding/surface samples. See `hide-samples.json`, `hide-independent.json`, and `attachment.json`. The existing production/performance assertions and budgets were not modified. This task did not run a performance workload.

API-specific investigation first resolved/queried Context7 for Tauri and Win32, then checked the exact installed Tauri 2.11.5 and Tao 0.35.3 Rust sources. Context7 had no matching Win32 entry for the specific DPI/SetWindowPos queries; the fallback was Microsoft's current [SetThreadDpiAwarenessContext](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext), [GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect), and [SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos) references. No library versions were changed.

## Commands, raw check output and exits

Commands ran with explicit `powershell.exe`, `login:false`. Cargo ran serially through the required D: wrapper. Builds/tests completed before capturing native appearance. `.superpowers/` is local ignored task evidence; the scoped commit contains the single Rust source change.

1. From `src-tauri`: `rtk proxy powershell.exe -NoProfile -File ../.superpowers/run-native.ps1 build -j 1` — exit 0 before source repair:

```text
   Compiling lumen v0.1.0 (C:\Users\kevin\.codex\worktrees\3505\Lumen\src-tauri)
    Finished `dev` profile [unoptimized] target(s) in 36.02s
```

2. `rtk proxy powershell.exe -NoProfile -File ../.superpowers/run-native.ps1 test -j 1 collapsed_launcher_has_no_full_window_material --lib` — exit 0:

```text
running 1 test
test window::tests::collapsed_launcher_has_no_full_window_material ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 360 filtered out; finished in 0.02s
```

3. `rtk proxy bun run node .superpowers/launcher-native-verify.mjs` — repeated behavioral RED before Rust change, exit 1, raw terminal error `Error: Fixture did not hide`. The raw command response and independent true Win32 status are in [hide-red.json](../../artifacts/native/launcher-appearance-2026-10-15/hide-red.json).

4. After the fixture-only source change, same serial build command — exit 0:

```text
   Compiling lumen v0.1.0 (C:\Users\kevin\.codex\worktrees\3505\Lumen\src-tauri)
    Finished `dev` profile [unoptimized] target(s) in 29.14s
```

5. `rtk proxy powershell.exe -NoProfile -File ../.superpowers/run-native.ps1 fmt --all -- --check` — exit 1, unchanged unrelated file:

```text
Diff in \\?\C:\Users\kevin\.codex\worktrees\3505\Lumen\src-tauri\src\provider_switcher\profile_ownership.rs:48:
         "opencode" => paths::opencode_config(home),
         "openclaw" => paths::openclaw_config(home),
         _ => {
-            return Err("unknown app; expected claude, codex, gemini, opencode, or openclaw".into());
+            return Err(
+                "unknown app; expected claude, codex, gemini, opencode, or openclaw".into(),
+            );
         }
     };
     ensure_within_home(home, &path)?;
```

6. `rtk proxy rustfmt --check --edition 2024 --config skip_children=true src/native_performance.rs` — exit 0, no output. `rtk proxy git diff --check` and staged diff check — exit 0. Git warned only about eventual LF-to-CRLF conversion.

7. `rtk proxy powershell.exe -NoProfile -File ../.superpowers/run-native.ps1 test -j 1 window::tests --lib` — exit 0:

```text
    Finished `test` profile [unoptimized] target(s) in 22.02s
running 9 tests
test window::tests::native_material_uses_documented_fallback_order ... ok
test window::tests::launcher_position_respects_scale_and_upper_fifth ... ok
test window::tests::native_geometry_table_matches_each_window_mode_contract ... ok
test window::tests::lifecycle_commands_reject_unknown_enum_values_and_apply_valid_values ... ok
test window::tests::native_shortcut_accelerators_remove_display_spacing ... ok
test window::tests::lifecycle_preferences_drive_monitor_and_close_branches ... ok
test window::tests::window_state_events_serialize_for_native_visibility_reconciliation ... ok
test window::tests::collapsed_launcher_has_no_full_window_material ... ok
test window::tests::runtime_lifecycle_preferences_load_persisted_values_and_fail_safe ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 352 filtered out; finished in 0.02s
```

8. Final `rtk proxy bun run node .superpowers/launcher-native-verify.mjs` — exit 0, six raw result records represented without transformation in [captures.json](../../artifacts/native/launcher-appearance-2026-10-15/captures.json). They report names `collapsed-initial-cyan`, `collapsed-initial-orange`, `expanded`, `expanded-to-collapsed-cyan`, `expanded-to-collapsed-orange`, `collapsed-reopened`, all `foregroundUnchanged:true`, with the exact table values above. Node runtime was v24.15.0, launched through Bun. Installed native WebView reports Edg/155.0.4283.45.

9. `rtk proxy git commit -m "fix: hide offline native fixture without activation"` — exit 0:

```text
[codex/production-readiness 911fa85] fix: hide offline native fixture without activation
 1 file changed, 33 insertions(+), 2 deletions(-)
```

## Failed attempts and limits

- Initial attempt to pipe the build through `Tee-Object` failed with exit 1 because PowerShell `ErrorActionPreference=Stop` interpreted Cargo's compilation stderr as `NativeCommandError`. Running the required wrapper directly succeeded. This failure was not a source compile failure.
- Running the diagnostic directly with the Bun runtime twice failed: installed Edge launch timed out at the original 20 seconds; the next attempt also timed out on a 5-second synchronous PowerShell process enumeration. Edge logged elevation helper `hr=80070002`, exit code 32. `browser-failure.json` preserves raw error/stack. Running via the repository's established `bun run node` pattern succeeded without increasing deadlines; the helper log did not establish the earlier launch failure's cause.
- One read-only diagnostic command incorrectly nested a double-quoted PowerShell block and expanded `$_` prematurely, producing repeated `.Name is not recognized`; corrected single-quoted commands succeeded. It made no state change.
- The first native screenshot attempt used DPI-virtualized `GetWindowRect` coordinates (700x66) with physical screen pixels, instead of the native fixture's 1050x99 physical rectangle. Both invalid PNGs were immediately deleted, and their samples were discarded. They do not support any visual conclusion. Subsequent attempts established per-thread DPI, exact physical dimension and full-coordinate ownership admission before accessing pixels. Two protected attempts refused pixels when WebView2 child ownership had not yet been admitted; only textual coordinate/owner diagnostics were retained. No invalid PNG is retained or published.
- A final shell `Get-FileHash` call failed because that cmdlet was unavailable in the host's PowerShell session. Node SHA256 readback is used for provenance; the hash is not inferred from that failed command.

## Cleanup and remaining acceptance

The archived [cleanup verification](../../artifacts/native/launcher-appearance-2026-10-15/cleanup-verification.json) independently found no final owned process IDs remaining: fixture PID `5880`, native browser listener PID `27676` and all recorded descendants are gone; underlay PID `36828` is gone (exit 0). The fixture tree was intentionally terminated by exact spawned PID after capture (`childExit:1` reflects that cleanup, not an application crash verdict). The owned Vite helper stopped its process in `finally`; no listener remained on strict port 1420. `fixture.log` and final `underlay.log` are empty. The fresh fixture data root `C:\Users\kevin\AppData\Local\Temp\lumen-native-performance-nYrIk1` remains as owned synthetic diagnostic state; no ordinary user profile was attached or cleaned. Earlier exact-owned fixture trees also ran their `finally` cleanup.

Sole native/source/test ownership is released. This establishes the requested launcher appearance on the rebuilt **offline native fixture** and its two transitions, plus separate installed-Edge alpha evidence. It does not establish ordinary user-session activation, packaged/release behavior, physical IME/Narrator, live providers, performance/240Hz acceptance or production readiness. Full ordered frontend/Edge/Rust/release/performance/artifact verification remains final Task14; the unrelated whole-repository formatting failure remains explicit.

## Review correction appendix

Independent review approved the scoped change with zero Critical or Important findings and identified one reporting Minor: the hide probe's `wait` values are successive awaited delays, not elapsed timestamps from hide. The RED/GREEN descriptions above now use that distinction and give approximate cumulative offsets with overhead explicitly unmeasured. This documentation-only correction changes no raw evidence, probe, deadlines, assertions, source, build, or runtime behavior. No further app, process, build, test, or Git commit was performed for the correction; runtime/source ownership remains released to Task6a.
