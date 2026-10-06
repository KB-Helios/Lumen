# Fixed Computer Use executor protocol v1

Rust is the only caller. Python is an execution worker, never a model agent. JSON lines on inherited stdin/stdout; diagnostics must not include task text, values, screenshots or credentials. Lines are bounded to 16 MiB. The worker never reads any provider key.

Commands have `id` (positive integer), `runId` (UUID string), `generation` (positive integer) and `type`: `begin`, `observe`, `act`, or `end`. Unknown fields/actions and mismatching run identity are rejected. A begin resets all observations, reference caches and browser/session state.

- `begin`: `target` is `{kind:"browser",initialUrl:string,headless:boolean}` or `{kind:"window",pid:integer,windowId:integer,executable:string}`. For Windows, `manifestPath` is an absolute Rust-generated capability manifest. Browser sessions always use installed `msedge`, fresh context, no existing profiles. Browser launch is headless unless Rust has approved visible launch.
- `observe`: `screenshot:boolean` (default false).
- `act`: `snapshotId:string`, `action:Action`. No delivery-mode argument: worker actions are always background. Rust owns approved foreground input. `act` performs an independent post-observation and returns both the result and current observation.
- `end`: closes the session/context. The worker can remain alive for the same immutable permission scope, but admits no input until the next begin. EOF closes everything.

All responses echo `id`, `runId`, `generation`, and contain `ok:boolean`, optionally `observation`, `result` or `error`. Errors have `code:string,message:string`; these must be content-free. Refusal codes include `backgroundUnavailable`, `staleSnapshot`, `targetUnavailable`, `invalidAction`, `observationUnavailable` and `workerError`.

## Action

Flat object with required `kind` and optional nullable `element`, `text`, `url`, `keys`, `x`, `y`, `endX`, `endY`, `direction`, `amount`. Allowed kinds: `invoke`, `setValue`, `select`, `scroll`, `navigate`, `keypress`, `click`, `doubleClick`, `rightClick`, `move`, `drag`, `type`, `wait`. Rust serializes all nullable keys; ignore null before checking per-kind fields, but reject unknown keys and unrelated nonnull fields. `select` requires `text` for the desired option value/label on a select-capable element. Scroll amount is 1–3,000 pixels, translated to native increments internally where supported. Reject oversized strings and invalid/nonfinite coordinates. Coordinate actions require the current screenshot observation. `wait` is an integral number bounded to 5,000 ms; it does not count as input. URL navigation is HTTP(S) only, with no embedded credentials.

For semantic actions, `element` is a snapshot-bound opaque ref. Each fresh observation invalidates all old refs. Rust re-resolves remaining planned refs against a unique matching semantic descriptor after each successful action; the worker never guesses. Input is never blindly replayed after an uncertain result.

## Observation

`{snapshotId:string,url?:string,title:string,elements:Element[],screenshot?:Image,width:number,height:number}`. At most 300 elements. A degraded/truncated observation must be declared `degraded:boolean` (default false), and is not sufficient for ambiguous input. Window-relative coordinates; screenshot width/height are the actual image dimensions. Screenshots are omitted entirely unless requested.

Element: `{ref:string,role:string,name:string,value?:string,automationId?:string,enabled:boolean,bounds?:{x:number,y:number,width:number,height:number},actions:string[]}`. Actions are a subset of `invoke,setValue,select,scroll`. Password/protected values are excluded. Browser refs must also work for supported frames; inaccessible/cross-process surfaces are refused honestly.

Image: `{mimeType:"image/png",data:string}` with base64 data and dimensions supplied by Observation.

Result: `{effect:"confirmed"|"unverifiable"|"suspectedNoop"|"partial"|"refused",route:"uia"|"win32"|"playwright"|"backgroundPixels"|"foreground",verified:boolean,detail?:string}`. `confirmed` requires a real state/read-back postcondition. A tool returning successfully is not sufficient. No-op clicks/coordinates are `unverifiable` or `suspectedNoop`, never automatic success. Cua refusals never trigger foreground retry.

## Health

`--health` returns one JSON line `{ready:boolean,edgeAvailable:boolean,desktopAvailable:boolean,detail?:string}` and exits. Ready is true if either execution route is installed and usable; desktop availability requires the packaged Cua SDK and native resources, Windows and a user interactive session. Missing Edge must not hide available desktop execution, or vice versa.

Runtime: Python 3.11, Playwright 1.62.0, `cua-driver==0.34.0` including its matching Windows x64 native resources. Pin the wheel SHA-256 `ecb2272eb3ac70399498934f7fc7166a4c6618ce5edcfe93563df30dbd23f66a`. Preserve third-party license/provenance. Tauri resolves the fixed executable/source worker itself; it never accepts a caller-provided binary/script path.
