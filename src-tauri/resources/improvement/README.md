# Optional pinned Prime runtime

Run `bun run stage:improvement` explicitly with an available Docker Desktop Linux engine before packaging to include the Prime runtime. Staging verifies the pinned source, builds the runtime archive and writes its SHA-256 manifest. The archive and manifest are bundled when present.

Lumen does not build, install or start Docker. The Prepare action loads the verified archive and probes the real ACP runtime. A missing artifact, missing engine or failed probe produces an unavailable state. This README does not constitute a prepared runtime.
