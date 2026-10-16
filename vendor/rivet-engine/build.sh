#!/bin/bash
set -euo pipefail
exec > >(tee /probe/engine-auth-build.log) 2>&1
export CARGO_HOME=/probe/cargo-home CARGO_TARGET_DIR=/probe/engine-target CARGO_BUILD_JOBS=1
export RIVET_ERROR_OUTPUT_DIR=/probe/error-docs
export RUSTFLAGS='--cfg tokio_unstable -C target-feature=+crt-static -C link-arg=-static-libgcc -C link-arg=-fuse-ld=lld -l static=stdc++ -L native=/usr/lib/gcc/x86_64-w64-mingw32/12-posix'
unset RUSTC_WRAPPER
printf '%s  %s\n' 5eadaaf4fe086d76547b17dc3c1ba880d0082b93f7d8bc65612770da8e79fe8e "$(rustup which rustc)" | sha256sum -c -
cd /source/rivet-2.3.10
printf '%s  %s\n' e1f7cd626fd7424e48724434d51f6f383f838e6a368212ac5152ff07006f34b2 Cargo.toml f811cac4956c243e86aeef172275fb375e1b748965ddf68db7d3a7fdc5dbb95d Cargo.lock | sha256sum -c -
printf '%s  %s\n' f2b2c9c5ba8d73bf4828e2b1013b1dda6901397aa92f24b52e47bc56e04f7497 /guard-actor-auth.patch | sha256sum -c -
actor_source=engine/packages/guard/src/routing/pegboard_gateway/mod.rs
if printf '%s  %s\n' ab3e2e3d65654be0e9522cb6c98a39703299f988794af6c0d0f5af1a6a63c506 "$actor_source" | sha256sum -c -; then
  patch --batch --fuzz=0 -p1 < /guard-actor-auth.patch
fi
printf '%s  %s\n' c64a4f641d4ccfd95176d95f726daa92c242797bff6e201b7b3c4b695980a253 "$actor_source" | sha256sum -c -
rustc --version -v
cargo build --locked -j 1 -p rivet-engine --bin rivet-engine --release --target x86_64-pc-windows-gnu
mkdir -p /probe/rebuilt-actor-auth
cp "$CARGO_TARGET_DIR/x86_64-pc-windows-gnu/release/rivet-engine.exe" /probe/rebuilt-actor-auth/rivet-engine.exe
x86_64-w64-mingw32-objdump -p /probe/rebuilt-actor-auth/rivet-engine.exe | sed -n '/DLL Name/p' | tee /probe/rebuilt-actor-auth/imports.txt
if grep -Ei 'libstdc|libgcc|libwinpthread' /probe/rebuilt-actor-auth/imports.txt; then exit 1; fi
sha256sum /probe/rebuilt-actor-auth/rivet-engine.exe | tee /probe/rebuilt-actor-auth/sha256.txt
