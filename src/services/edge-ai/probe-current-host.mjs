import {build, write} from 'bun';
import {spawn} from 'node:child_process';
import {fileURLToPath, URL} from 'node:url';

// Passive verification only: no create/install calls, provider flags, or microphone access.
globalThis.console.log('Bundling the adapter for passive host verification.');
const bundle = await build({
  entrypoints: [fileURLToPath(new URL('./edge-ai-service.ts', import.meta.url))],
  target: 'browser',
  format: 'esm',
  minify: true,
});
if (!bundle.success) throw new Error('Could not build the current Edge adapter for host verification.');
const source = await bundle.outputs[0].text();
globalThis.console.log('Launching the installed Edge browser through the repository Playwright runtime.');
const worker = spawn('node', [fileURLToPath(new URL('./probe-browser-host.mjs', import.meta.url))], {stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true});
const output = [];
worker.stdout.on('data', (chunk) => output.push(chunk.toString()));
worker.stdin.end(source);
await new Promise((resolve, reject) => {
  worker.once('error', reject);
  worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`The passive browser probe failed with exit code ${code}.`)));
});
const evidence = JSON.parse(output.join(''));
const report = {
  observedAt: new Date().toISOString(),
  host: 'Installed Microsoft Edge, headless Playwright, fresh automation profile, secure loopback origin',
  modelDownloadsRequested: false,
  modelSessionsCreated: false,
  microphoneActivated: false,
  experimentalFlagsEnabled: false,
  webView2Readiness: 'Not probed; installed Edge does not establish WebView2 support',
  ...evidence,
};
await write(fileURLToPath(new URL('./current-host-probe.json', import.meta.url)), `${JSON.stringify(report, null, 2)}\n`);
globalThis.console.log(JSON.stringify(report, null, 2));
