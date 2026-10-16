# Pinned Windows Rivet engine

Lumen stages this compressed pinned2.3.10 runtime offline using `bun run stage:sidecars`. `scripts/stage-rivet-engine.ts` verifies compressed and executable sizes and SHA256 before replacing output. The original npm Windows binary mixed static libgcc and dynamic libstdc++ emulated TLS and crashed with0xc0000005. This rebuild links both statically and carries one hash-pinned actor-auth source patch; the recorded PE imports require only Windows system libraries. Diagnostic IAT patches are never shipped.

`provenance.json` records the actual reviewed build. `THIRD-PARTY-NOTICES.txt` retains original Rivet/Cargo notices and exact builder GNU C++, libgcc and MinGW copyright/license text, including the GCC Runtime Library Exception. The conservative Cargo notices include downloaded build-only/conditional inputs. Staging copies notices into the packaged resources; installed search/enrichment never invokes Docker or a compiler.

Native launch fixes `start --except-services api_peer` with a single local leader datacenter. The pinned private peer API does not enforce the public admin token; its listener is unnecessary for this topology and is excluded entirely. Local public handlers/namespace/consensus paths call their local operations directly. Public management, the engine-to-worker callback and controller require the native-owned token. The source patch validates that same configured authority in constant time before actor allocation or direct/header dispatch. Actor actions additionally validate the original caller's Authorization header in `onBeforeConnect`: pool headers identify the engine rather than its caller. Authentication headers keep the token out of action URLs and recovery logs. Tests prove the peer port can be bound while the engine runs, anonymous/invalid mutation and allocation are rejected, and actual durable queue/search/restart/recovery still work. Multi-datacenter cluster and remote debug CLI operation are outside Lumen's fixed local runtime; do not enable the unauthenticated peer service when maintaining this integration.

Producer prerequisites: Linux Docker engine, internet to the pinned source/builder/Rust/crate archives, curl, tar, sha256sum, and an owned output directory with roughly20GiB free. This is an explicit maintenance build, outside app startup and the normal Windows package job. Example from a repository checkout (paths refer only to newly created owned producer directories):

```sh
mkdir -p .superpowers/rivet-producer/source .superpowers/rivet-producer/output
curl --fail --location 'https://codeload.github.com/rivet-dev/rivet/tar.gz/refs/tags/v2.3.10' -o .superpowers/rivet-producer/source.tar.gz
printf '%s  %s\n' b98ec5dfd86bd8811ed8b7907deb42250a2f387d5c5712984f5aee5b2e06dc45 .superpowers/rivet-producer/source.tar.gz | sha256sum -c -
tar -xzf .superpowers/rivet-producer/source.tar.gz -C .superpowers/rivet-producer/source
docker build -f vendor/rivet-engine/Dockerfile.builder -t lumen-rivet-producer:2.3.10 vendor/rivet-engine
docker run --rm --name lumen-rivet-producer-2310 --memory 6g --cpus 2 \
  -v "$PWD/.superpowers/rivet-producer/source:/source" \
  -v "$PWD/.superpowers/rivet-producer/output:/probe" \
  -v "$PWD/vendor/rivet-engine/build.sh:/build.sh:ro" \
  -v "$PWD/vendor/rivet-engine/guard-actor-auth.patch:/guard-actor-auth.patch:ro" \
  lumen-rivet-producer:2.3.10 bash /build.sh
```

The original archive remains immutable. The recipe applies only the hash-pinned actor-auth patch to the newly extracted owned source, with zero patch fuzz and exact original/patched module hashes. The supported error-document output redirect writes generated documentation into the owned output directory. Original consistent-linkage build elapsed127m24s with jobs1; the necessary security repair reuses that verified cache. The recipe verifies the actual compiler executable and lockfile before compiling, records imports/hash, and rejects GNU DLL dependencies. Do not overwrite the vendored artifact with an unchecked producer result. First run normal uninstrumented engine, compiled worker recovery, and native searchable-consumer gates, regenerate notices, then independently review both compressed/executable pins. Upstream timestamped build metadata currently prevents a byte-identical rebuild claim; no fabricated release URL or unverified environment-selected binary is accepted.
