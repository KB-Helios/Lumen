import {expect, test} from 'bun:test';
import * as bindings from '@rivetkit/rivetkit-wasm';
import wasmPath from '@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm' with {type: 'file'};

const module = new WebAssembly.Module(await Bun.file(wasmPath).arrayBuffer());

for (const entry of ['mod.js', 'mod.cjs']) {
  test(`pinned ${entry} serves WASM metadata without resolving a spawn path`, async () => {
    const {setup} = await import(`../node_modules/rivetkit/dist/tsup/${entry}`);
    const registry = setup({
      use: {}, runtime: 'wasm', wasm: {bindings, initInput: {module_or_path: module}}, sqlite: 'remote',
      endpoint: 'http://127.0.0.1:26490', startEngine: false, noWelcome: true,
      serverless: {publicEndpoint: 'http://127.0.0.1:26490'},
    });
    const response = await registry.handler(new Request('http://127.0.0.1:26491/api/rivet/metadata'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({clientEndpoint: 'http://127.0.0.1:26490/', runtime: 'rivetkit', version: '2.3.10'});
  });
}
