# Task 6a source milestone — Docker acceptance pending

Date: 2026-10-15. Source base: 911fa8546d57aba87d2e3ddff2169b928666c4ff, branch codex/production-readiness. This report accompanies only the bounded exporter and test-harness change. It does not complete Task 6a runtime acceptance, Task 6b, or production readiness.

## Change and preserved boundaries

The staging exporter writes a Docker tar to an explicit child of its owned staging directory, then explicitly loads that same tar before image inspection and the existing save/canonicalization/publication path. It retains SOURCE_DATE_EPOCH=1791353246, pinned Prime 0.9.8 revision 2ed835646120f79562407879ff19e8860623775c, source SHA256 268cd8c2a925bce531dcd0062aeed5360e4d5b10ec4fdeb6131e2a043d6a44bd, pinned Rust/Python base digests, context normalization, canonical archive, 2 GiB archive cap, manifest-last rename and contained cleanup. No image or archive was produced on this source; their hashes remain unavailable.

The architecture documentation now says two CPUs, matching unchanged production admission. Only the existing cfg(test) module in docker.rs changes: shared inspect assertions include CPU2, memory/swap2GiB, PID128, tmpfs/nofile, network-none, UID10001, dropped capabilities and no bind/extra mounts. Existing Prime/canned-broker acceptance now captures a real running generation container after an observed model request; cancellation is issued before inspection assertions, including on inspection failure. Same-owner reopening removes a separately created orphan while preserving another owner's canary, explicitly without claiming an abrupt process crash.

One new ignored acceptance test runs the fixed, audited sandbox_probe.py through an entrypoint override under the exact production sandbox arguments. The override is test-only; no production arbitrary executable/arguments API or product shell permission is added, and this diagnostic script is not copied into the staged image. It uses an owned random host file/token and an owned host TCP listener with a successful host control connection; the guest must fail host-file/socket/network access, omit the host-only dummy environment token, reject root writes/scratch execution, allow scratch writes, read cgroup limits/kernel privilege flags, and reach EMFILE at the unchanged nofile bound. Returned evidence contains booleans only. This probe supports Docker Desktop cgroup v2; unsupported layouts fail rather than skip. CPU/memory/PID saturation, actual provider credential contents, and real model behavior are not exercised by it.

The guest 590/native 600/broker 120/stdin 5 second deadlines, model/action/budget quotas, evaluator thresholds, consent and promotion logic remain unchanged. No coordinator join, fabricated Prime/candidate, held-out input or live-provider/cloud grant was added. Python ACP fixture tests use acp_fixture.py plus canned inference; they are transport/fixture evidence only.

## Docker prerequisite and latest user boundary

At initial preflight C: had 121690468352 bytes free and D:335882735616. Last later read was C:121916850176/D:335499579392; these are snapshots, not reservations. Large test scratch uses the process-local non-reparse D:/CodexBuilds/Lumen/task6a-20261015. Preserved archives, producer/cache/source, IPC backups, configuration, trust, WSL/VHD and unrelated processes/containers were not modified.

Exact process identity was Desktop 35628 (C:/Program Files/Docker/Docker/Docker Desktop.exe, created 2026-10-14T21:32:59.145UTC), backend 34004 (parent35628, created 21:32:59.268), backend 44916 (parent34004, created 21:32:59.957), both at the installed resources/com.docker.backend.exe path. LinuxEngine pipe was absent. monitor.log records a disk-full log write during that startup at 21:33:00.0928UTC; no later backend-ready evidence was observed. The earlier recovered 29.6.2 engine checkpoint was not treated as current.

One normal hidden launch was issued via rtk proxy powershell.exe -NoProfile -Command 'Start-Process -FilePath "C:/Program Files/Docker/Docker/Docker Desktop.exe" -WindowStyle Hidden'. No new healthy instance/pipe appeared. A first bounded Bun inline-version helper had a quoting syntax error (exit1), and Get-Date -AsUTC was unsupported in Windows PowerShell; the direct version command below established actual engine unavailability instead.

Exact command: rtk proxy docker --host npipe:////./pipe/dockerDesktopLinuxEngine version --format "{{json .Server}}". Exit1, raw output:

```text
nullfailed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: Det går inte att hitta filen.
```

After explicit root authorization, identity and absent pipe were reverified. Current installed help and Context7 /docker/docs documented normal Desktop lifecycle commands. One graceful restart used rtk proxy docker desktop restart --timeout 30. Exit1, raw output:

```text
✗ Failed to stop Docker Desktop
stopping Docker Desktop: stopping Docker Desktop: processes still running: C:\Program Files\Docker\Docker\Docker Desktop.exe (35628) C:\Program Files\Docker\Docker\resources\com.docker.backend.exe (34004) C:\Program Files\Docker\Docker\resources\com.docker.backend.exe (44916): context deadline exceeded
```

No force stop/reset/prune/config/IPC repair followed. The user then said “Keep Docker acceptance pending.” Accordingly no current-source stage, prepare/standalone acceptance, ignored Docker test, expiry or restart-recovery operation was launched. Engine-dependent gates remain pending by instruction; old engine failures are not current-source exporter execution evidence.

## Covering checks and raw evidence

Commands ran through explicit powershell.exe/login:false tool shells, each starting rtk. The checked-in standalone Cargo manifest includes the actual production Docker module; native compile/check operations used .superpowers/run-native.ps1, D:/CodexBuilds/Lumen/production-readiness and -j1. No competing image/native build ran. Full lint and full Vitest overlapped for part of this run; no latency/performance acceptance is inferred, and their failures were retained without broad reruns or changed thresholds.

Raw stdout/stderr and command/start/end/exit/SHA256 JSON are retained locally in .superpowers/sdd/2026-10-12-production-readiness/task6a-evidence/. These local tool-workspace logs are not added to Git. The following SHA256 values identify their exact bytes.

| Check | Exit | stdout SHA256 | stderr SHA256 |
| --- | ---: | --- | --- |
| typecheck | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92 |
| lint | 1 | 66e9ae6b2b586fb7b5a406371428114e1a45a209500dd734eff04cbbb63e15e4 | 8bd64e3d1530658fb1573ceafbcf24afc384faba1e30ff10a491b507101f96ee |
| unit | 1 | 7ca315c58df501613fa1a77d44e2842129a7ec271acdb137d1f9c967cc300019 | 2910dbabea29e2c3f4b7bd2d63f196e9404fc30cd8fc6b9961da227419a5746f |
| exporter | 0 | 862ec40759823597a4e4d8b52d3bfffb3f94a3cb83493f3977bd852ae0a218a1 | fd26f6ba8c357076bb0b0b3776bd2a43fae60cd4db07af484cd93b9e1f788d7b |
| lint-scoped | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| rust-fmt | 0 | 83e0d22e17ff71740661d9c6a252f73f6a9180125dc15888ce3765cd91d2592c | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| rust-clippy | 0 | 83e0d22e17ff71740661d9c6a252f73f6a9180125dc15888ce3765cd91d2592c | 699ecdf825c39ca6ff2edaa3835a8f501e4dabf3822d799d3ef72a54f733a138 |
| rust-test | 0 | aa00f4ae0124e55847870baba5b30240e4b4cd629370f2be559f209fdb6b0227 | 16131cd6803f2956f9b6ea19b31b1b756b918c415c44cd84aed9eb394207ffa6 |
| python | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 1ff8d69a88896bd1dc110fc74022d034ea43041fda092fdc1a0eb2392808e084 |

Exact commands:

- typecheck: ["rtk","proxy","bun","run","typecheck"]
- lint: ["rtk","proxy","bun","run","lint"]
- unit: ["rtk","proxy","bun","run","test"]
- exporter: ["rtk","proxy","bun","run","test","--","scripts/stage-improvement.test.ts"]
- lint-scoped: ["rtk","proxy","bun","x","--no-install","eslint","scripts/stage-improvement.ts","scripts/stage-improvement.test.ts","--max-warnings","0"]
- rust-fmt: ["rtk","proxy","powershell.exe","-NoProfile","-File",".superpowers/run-native.ps1","fmt","--manifest-path","workers/improvement-runtime/rust-tests/Cargo.toml","--all","--","--check"]
- rust-clippy: ["rtk","proxy","powershell.exe","-NoProfile","-File",".superpowers/run-native.ps1","clippy","--manifest-path","workers/improvement-runtime/rust-tests/Cargo.toml","--all-targets","-j","1","--","-D","warnings"]
- rust-test: ["rtk","proxy","powershell.exe","-NoProfile","-File",".superpowers/run-native.ps1","test","--manifest-path","workers/improvement-runtime/rust-tests/Cargo.toml","-j","1","--","--nocapture"]
- python: ["rtk","proxy","python","-m","unittest","discover","-s","workers/improvement-runtime","-p","test_*.py","-v"]

Results: typecheck passed; focused Vitest exporter 1/1 and scoped ESLint passed; standalone Rust fmt/Clippy passed, deterministic tests 9 passed/2 ignored; Python 14/14 passed. The ignored tests are pending, not passes. Full lint exit1 had 4915 problems (4910 errors/5 warnings), largely under pre-existing ignored .superpowers source/tool workspaces, including10 errors in this run's untracked logging helper. No lint config/exclusions were changed. Full Vitest exit1:80 files/710 tests passed,7 files/8 tests failed,718 total. Six failures were unchanged5000ms UI timeouts (providers profile removal, Computer Use newer credential/provider cases, embedded start-page credentials, keyboard DOM order and Unicode launcher input); App health mock was not called; Computer Use staging fixture cleanup hit EBUSY after its child timeout. These unrelated failures remain unresolved; no success is inferred from prior runs. The new exporter test passed in this full run and in the focused final run.

Initial regression evidence: the exporter contract failed against the old source because owned exported-image.tar was absent (Bun exit1), then passed after the narrow fix. The test was changed from bun:test to Vitest so the actual repository runner admits it. That runner initially exposed a jsdom URL-scheme mismatch, fixed with node:path/import.meta.dirname; focused final Vitest passed unchanged assertions. The Python limits test initially failed on missing sandbox_probe; the first implementation then exposed Windows' lack of resource, fixed by making that Linux-only import local to the guest probe. Parser positive/negative cases then passed. An initial PowerShell logging wrapper failed after successful Cargo tests because Get-FileHash was unavailable; the final Bun logger reran the relevant final scoped checks and retained exact raw streams/hash metadata. Those harness failures are not product runtime passes.

No installed-Edge e2e, full Tauri release/package build or full-app Rust gate was run for this test-only native source milestone. They remain final integration gates; this milestone is not a green full-app gate. No UI/perf change was made, so no new gallery/recording/profiling claim is made.

## Pending runtime acceptance and handoff

Full pinned staging and explicit prepare/load; two equivalent builds/image/archive identity comparison; real Prime ACP initialization/generation/cancel; actual running configuration and empirical confinement probe; guest 590 expiry versus native 600 fallback; broker 120/stdin 5 runtime boundaries; actual abrupt-exit orphan recovery and verified zero owned survivors all remain pending. CPU/memory/PID saturation remains unmeasured. Task6b retains the actual queue/coordinator/evaluator/promotion/rejection/immutable-rollback/recovery join. Synthetic inference cannot establish live candidate quality, upstream authentication or model improvement.

Future explicit runtime commands (not run here) use bun run stage:improvement with owned D: TEMP/TMP, the standalone acceptance binary with explicit assets and --prepare, and the named ignored tests actual_docker_prime_acceptance_generation_cancel_and_ownership and actual_docker_sandbox_empirical_confinement under the existing Cargo wrapper. Preserve all budgets/deadlines, current source/image pins, native owner labels and separately granted model/observation consent.

Source/native/Docker/build/test ownership is released after the scoped commit for independent review. No push. Root-owned untracked docs/superpowers/plans/2026-10-12-production-readiness.md is excluded.

## Source content hashes

| File | SHA256 |
| --- | --- |
| scripts/stage-improvement.ts | e85aac2229ef51bfbde5d3b15376836052759332f48bb3e60507ed1d3ffe4e3c |
| scripts/stage-improvement.test.ts | d8e4fe3f03a86c0f21cf8702501b32de92ac00dfa2670e7cb2540afd2fc42684 |
| src-tauri/src/improvement/docker.rs | 63dec90f7ea2fd4182d8f5044b015e181aec4c2843f2562aeae422bc18555ed6 |
| workers/improvement-runtime/sandbox_probe.py | 10fad2765bcb02ec95578061776899949ece15930b82e1808e80eb01c8474603 |
| workers/improvement-runtime/test_sandbox_probe.py | be91713b3875393ec1885b64d728be6671a5ba23b852538f2818f6d793a92eca |
| workers/improvement-runtime/Dockerfile | 95b4184ed544c3e4d931b185ad12cb2024c3fcbdfdceeda234e47398c785c1d6 |
| workers/improvement-runtime/requirements.lock | a2fbd01e491e90bedfff15c1dcbf3115cf2ae2771769f8b68a69900be8919dbf |
| docs/architecture/improvement.md | 64287b7609a6986053bdeb5e0380ada769a96640d5bca15319439ec5bb19d490 |

Current documentation consulted through Context7: [BuildKit Docker tar export](https://github.com/moby/buildkit/blob/master/README.md), [BuildKit reproducibility](https://github.com/moby/buildkit/blob/master/docs/build-repro.md), [Docker Desktop CLI](https://github.com/docker/docs/blob/main/content/manuals/desktop/features/desktop-cli.md). These references support the exporter/lifecycle syntax; they do not establish a local runtime pass.

## Task 6a review fix round 1: awaited failure cleanup

Fix base: a7bad9d1bf25f50b664bd4eae9f0b487df6e7f43. The independent review found a valid Important issue: the new probe could panic after create before awaiting exact-owner container and host-canary removal, while ContainerGuard Drop only scheduled an unobserved cleanup future. This round changes only the cfg(test) module and this report; the textual exporter-test Minor remains deferred to final triage.

The diagnostic probe now runs through a test-only result-producing helper. It catches probe assertion unwinds, retains operation errors, awaits the exact-owner container cleanup, then attempts canary deletion even if container cleanup failed, and only afterward returns a pass or failure. Cleanup failures include CLEANUP_UNCERTAIN plus separate probe/container/canary outcomes; container errors retain the generated owner/name, and canary errors retain its owned path. Cleanup is attempted whenever create was attempted, including create failure or timeout with uncertain delivery. Failures before create still remove any canary but do not invoke nonexistent-container cleanup. The new probe no longer depends on ContainerGuard's asynchronous Drop. Existing exact-owner verification, assertions, image/resource controls, bounds and deadlines are unchanged. Production ContainerGuard and execution APIs are unchanged.

Three deterministic tests cover probe error and assertion panic ordering across an async cleanup yield, simultaneous container/canary failures without losing the probe error, and successful probe results that cannot pass when cleanup fails. The synthetic assertion deliberately invokes Rust's panic hook; its caught panic line in raw stderr is expected. The check must still report zero failed tests. Process abort, external cancellation/termination and actual Docker deletion are not established by these in-process cases; abrupt-exit/runtime gates remain pending.

Pre-write capacity snapshot was C: 121812385792 bytes, D: 335442673664 bytes; no unrelated cleanup was performed. Docker remains pending by the user's instruction. No Docker command/start/stage/runtime attempt, Python change/test or broad frontend/full-lint rerun was made in this round. Previous full-app gate failures remain recorded, without independently proving their cause here.

Regression-first command: rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path workers/improvement-runtime/rust-tests/Cargo.toml -j 1 probe_ -- --nocapture. Before the helper existed this exited 1 with two E0425 errors: cannot find function probe_then_cleanup in this scope. After the helper and first two cases were implemented the same command exited 0 (2 passed). The final standalone suite below includes all three added tests.

Final raw command metadata/stdout/stderr are retained separately from the original evidence in .superpowers/sdd/2026-10-12-production-readiness/task6a-fix1-evidence/. Final covering commands and exact raw output follow. Native compile/test operations used the serial D: wrapper; source and compile ownership is released after this scoped commit. No push.

### rust-fmt

Command arguments: ["rtk","proxy","powershell.exe","-NoProfile","-File",".superpowers/run-native.ps1","fmt","--manifest-path","workers/improvement-runtime/rust-tests/Cargo.toml","--all","--","--check"]

Exit: 0. Start: 2026-10-15T01:38:49.967Z. End: 2026-10-15T01:38:59.120Z.

stdout SHA256: 83e0d22e17ff71740661d9c6a252f73f6a9180125dc15888ce3765cd91d2592c. stderr SHA256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.

Raw stdout:

```text
**********************************************************************
** Visual Studio 2026 Developer PowerShell v18.9.3
** Copyright (c) 2026 Microsoft Corporation
**********************************************************************
```

Raw stderr:

```text
```

### rust-clippy

Command arguments: ["rtk","proxy","powershell.exe","-NoProfile","-File",".superpowers/run-native.ps1","clippy","--manifest-path","workers/improvement-runtime/rust-tests/Cargo.toml","--all-targets","-j","1","--","-D","warnings"]

Exit: 0. Start: 2026-10-15T01:39:14.971Z. End: 2026-10-15T01:39:24.860Z.

stdout SHA256: 83e0d22e17ff71740661d9c6a252f73f6a9180125dc15888ce3765cd91d2592c. stderr SHA256: 455af489817aca58bddd699b802854f3cf4981fc7e21c21e0231c2a4f5988366.

Raw stdout:

```text
**********************************************************************
** Visual Studio 2026 Developer PowerShell v18.9.3
** Copyright (c) 2026 Microsoft Corporation
**********************************************************************
```

Raw stderr:

```text
    Checking lumen-improvement-runtime-tests v0.1.0 (C:\Users\kevin\.codex\worktrees\3505\Lumen\workers\improvement-runtime\rust-tests)
    Finished `dev` profile [unoptimized] target(s) in 3.42s
```

### rust-test

Command arguments: ["rtk","proxy","powershell.exe","-NoProfile","-File",".superpowers/run-native.ps1","test","--manifest-path","workers/improvement-runtime/rust-tests/Cargo.toml","-j","1","--","--nocapture"]

Exit: 0. Start: 2026-10-15T01:40:19.017Z. End: 2026-10-15T01:40:36.668Z.

stdout SHA256: 74c50007f005d3835a5a635194da41438bf047e280b2740701708cc9c9271b82. stderr SHA256: 8ac3d270ac09dcb90c2b234a75b313c254c032fd0a6eacaa9d2d852631094d67.

Raw stdout:

```text
**********************************************************************
** Visual Studio 2026 Developer PowerShell v18.9.3
** Copyright (c) 2026 Microsoft Corporation
**********************************************************************

running 14 tests
test docker::tests::actual_docker_prime_acceptance_generation_cancel_and_ownership ... ignored, Requires explicit LUMEN_IMPROVEMENT_ASSETS, staged pinned image and running Docker Desktop Linux engine; synthetic broker, real Prime ACP
test docker::tests::actual_docker_sandbox_empirical_confinement ... ignored, Requires explicit staged assets and healthy Docker; actual diagnostic guest under production sandbox args, no inference
test docker::tests::cleanup_rejects_a_container_owned_by_another_installation ... ok
test docker::tests::duplicate_guest_protocol_keys_are_rejected ... ok
test docker::tests::sandbox_arguments_do_not_admit_host_access ... ok
test docker::tests::broker_request_cannot_change_route_or_send_extra_network_fields ... ok
test docker::tests::metadata_input_rejects_extra_private_payloads ... ok
test docker::tests::initial_harness_version_zero_is_valid_for_first_generation ... ok
test docker::tests::probe_cleanup_uncertainty_preserves_both_failures_and_still_removes_canary ... ok
test docker::tests::probe_success_requires_successful_cleanup_before_returning_value ... ok
test docker::tests::probe_failure_still_awaits_both_cleanup_steps ... ok
test docker::tests::oversized_unterminated_frame_is_rejected_without_waiting_for_eof ... ok
test docker::tests::interleaved_broker_completion_preserves_partially_consumed_frame ... ok
test docker::tests::blocked_guest_stdin_does_not_block_native_cancellation ... ok

test result: ok. 12 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.01s


running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

Raw stderr:

```text
   Compiling lumen-improvement-runtime-tests v0.1.0 (C:\Users\kevin\.codex\worktrees\3505\Lumen\workers\improvement-runtime\rust-tests)
    Finished `test` profile [unoptimized] target(s) in 8.76s
     Running unittests src\lib.rs (D:/CodexBuilds/Lumen/production-readiness\debug\deps\lumen_improvement_runtime_tests-3601157dabba695f.exe)

thread 'docker::tests::probe_failure_still_awaits_both_cleanup_steps' (33892) panicked at src\..\..\..\..\src-tauri\src\improvement\docker.rs:15:21:
synthetic probe assertion
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
     Running unittests src\bin\acceptance.rs (D:/CodexBuilds/Lumen/production-readiness\debug\deps\acceptance-90de03a04f377e44.exe)
   Doc-tests lumen_improvement_runtime_tests
```

Final covering results: standalone Rust fmt and Clippy with warnings denied exited 0; standalone Rust tests exited 0 with 12 passed, 0 failed and 2 ignored. Current working-file SHA256 for src-tauri/src/improvement/docker.rs: 3d504bb8cfafc5ec98b773bba074d0e2f23e097a9e929216b4f0ea69106fdc05. The earlier content-hash table describes the initial source milestone. Ignored Docker tests are still pending, not passes.
