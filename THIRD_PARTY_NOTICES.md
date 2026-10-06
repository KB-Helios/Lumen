# Third-Party Notices

## sqlite-vector

- Project: sqlite-vector
- Version: 1.0.0
- Source: https://github.com/sqliteai/sqlite-vector
- Bundled artifact: `vector.dll` from `@sqliteai/sqlite-vector-win32-x86_64@1.0.0`
- Artifact SHA-256: `58ac4a99ff6904fd709f01b366cf0477c405b5bda45b96cf00e13d500aa60c6a`
- License: Elastic License 2.0, modified with an additional grant for open-source projects. The bundled package states that open-source projects under an OSI-approved license may use, copy, modify, and distribute the software without fee. Non-open-source or commercial production use requires a commercial license from SQLite Cloud, Inc.

The upstream license text is distributed in the installed package as `LICENSE.md`.

## CLIProxyAPI

- Project: CLIProxyAPI
- Source: https://github.com/router-for-me/CLIProxyAPI
- License: MIT License. Copyright (c) 2025-2005.9 Luis Pater; Copyright (c) 2025.9-present Router-For.ME.
- Usage: built as the `cliproxy-sidecar` Go binary staged by `bun run stage:clipproxy`. Lumen's `provider_switcher` Rust service drives its loopback-only `/v8/management` API (config, credentials, OAuth, usage). No CLIProxyAPI source is vendored into this repo.

## cc-switch

- Project: cc-switch
- Source: https://github.com/farion1231/cc-switch
- License: MIT License. Copyright (c) 2025 Jason Young.
- Usage: design reference for the atomic file-switch engine (`src-tauri/src/provider_switcher/files.rs`), the union vendor presets, and the Providers/AuthCenter/Usage settings panels. The ported logic was rewritten against Lumen's Tailwind CSS v4 + EinUI primitives and the Tauri `provider_switcher` service; no cc-switch source is vendored into this repo.
