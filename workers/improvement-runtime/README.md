# Prime guest runtime

The application never installs or starts Docker. Preparation is an explicit native command that verifies the bundled archive checksum, loads the exact image ID, and runs a disposable ACP initialize/new/cancel probe. Health requires the local Linux amd64 engine with built-in seccomp, the pinned image ID and labels, and that isolated protocol probe.

The fixed native launcher creates non-root, read-only, network-none containers with no host mounts or secrets, dropped capabilities, no-new-privileges, two CPUs, 2 GiB RAM/swap, 128 PIDs and bounded tmpfs. Every container carries installation-owner and run labels. Cancellation and deadline handling force-remove the exact inspected owned container; cleanup failures are reported, never disguised as completed cancellation. A drop guard attempts the same owned cleanup if its future is dropped; controller startup must call `cleanup_owned` for orphan recovery.

The credential-free Python bridge starts the pinned Rust Prime executable and a guest-loopback HTTP proxy. Only protocol-v1 NDJSON travels over Docker attach stdio. Host model requests use OpenAI Chat Completions with `model: lumen-host`, `stream: false`; Rust owns the real captured route, keys, consent and accounting. The guest converts complete metered responses into SSE for Prime, including tool calls and usage. Requests, output, files and manifests remain untrusted. The host validates the strict candidate manifest again before native evaluation or approval.

Candidate inputs contain only the supplied active harness, metadata failures, evidence/config digests and fixed development prompts. No Lumen source, active state, evaluator or held-out files are part of the build context or mounted in the guest. Scratch sessions, daemon state and refinement state disappear with the container.

Developer staging: `rtk bun scripts/stage-improvement.ts`. Requires the installed Docker Desktop Linux engine to be running. This verifies the pinned Prime source archive, builds from digest-pinned Rust/Python bases and hash-pinned Python dependencies, installs Python packages offline, normalizes source/layer/archive timestamps, and publishes `src-tauri/resources/improvement/improvement-runtime.tar` plus `improvement-runtime.json` last. Artifacts do not exist until the actual build succeeds. Rebuild equality must still be verified on an available engine.

Dedicated checks:

```powershell
rtk proxy python -m unittest discover -s workers/improvement-runtime -p 'test_*.py'
rtk cargo test --manifest-path workers/improvement-runtime/rust-tests/Cargo.toml
rtk cargo clippy --manifest-path workers/improvement-runtime/rust-tests/Cargo.toml --all-targets -- -D warnings
rtk cargo run --manifest-path workers/improvement-runtime/rust-tests/Cargo.toml --bin acceptance -- src-tauri/resources/improvement --prepare
rtk cargo test --manifest-path workers/improvement-runtime/rust-tests/Cargo.toml actual_docker_prime_acceptance -- --ignored --nocapture
```

Python integration tests use an ACP fixture process and a real loopback HTTP/SSE connection. They are bridge/protocol tests, not live Prime or Docker acceptance. The acceptance binary uses the real native Docker runtime with a synthetic metered broker; a completed run proves ACP/container wiring, not live model quality. It exits 2 and reports `unavailable` when prerequisites are absent. Full live model, container cancel/kill, orphan isolation and reproducible rebuild acceptance require a functioning Linux engine and the staged image.

The opt-in ignored Rust acceptance test requires `LUMEN_IMPROVEMENT_ASSETS` to name explicitly staged/prepared assets. It uses actual Docker/Prime to inspect the isolation config, complete generation, cancel after observing a model request, prove no owned container survives and prove another installation's container survives cleanup. Do not count its ignored result as native acceptance.
