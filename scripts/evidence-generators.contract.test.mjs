import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const captureGallery = await readFile(new URL('./capture-gallery.mjs', import.meta.url), 'utf8');
const devServer = await readFile(new URL('./lib/lumen-dev-server.mjs', import.meta.url), 'utf8');
const recordInteractions = await readFile(new URL('./record-interactions.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('gallery capture consumes registry categories exposed by scenario options', () => {
  assert.match(captureGallery, /category:\s*option\.dataset\.category/);
  assert.match(captureGallery, /category:\s*scenario\.category/);
  assert.doesNotMatch(captureGallery, /function categoryFor/);
});

test('gallery capture waits for the production provider and runtime fixture states', () => {
  assert.match(captureGallery, /providers-add/);
  assert.match(captureGallery, /providers-edit/);
  assert.match(captureGallery, /providers-remove/);
  assert.match(captureGallery, /getByRole\('dialog'\)/);
  assert.match(captureGallery, /local-runtime-provisioning/);
  assert.match(captureGallery, /Cancel local core download/);
});

test('approval recording clicks and asserts both deterministic decisions', () => {
  assert.match(recordInteractions, /getByRole\('button', \{name: 'Approve once'\}\)\.click\(\)/);
  assert.match(recordInteractions, /getByRole\('status', \{name: 'Working'\}\)/);
  assert.match(recordInteractions, /getByRole\('button', \{name: 'Deny and stop'\}\)\.click\(\)/);
  assert.match(recordInteractions, /getByRole\('status', \{name: 'Stopped'\}\)/);
});

test('development server owns one direct Vite child and awaits its shutdown', () => {
  assert.match(devServer, /spawn\(\s*process\.execPath/);
  assert.match(devServer, /await stopDevelopmentServer\(child\)/);
  assert.doesNotMatch(devServer, /spawn\(\s*'bun'/);
  assert.equal(packageJson.scripts['test:e2e'], 'node scripts/run-e2e.mjs');
});

test('recordings explicitly allow motion while gallery captures retain reduced motion', () => {
  assert.match(recordInteractions, /reducedMotion:\s*'no-preference'/);
  assert.match(captureGallery, /reducedMotion:\s*'reduce'/);
});

test('launcher recording sustains the real search lifecycle for active-loop evidence', () => {
  assert.match(recordInteractions, /async function sustainSearchActivity/);
  assert.match(recordInteractions, /await sustainSearchActivity\(page\)/);
  assert.match(recordInteractions, /querySelectorAll\('\[role="tab"\]'\)/);
  assert.match(recordInteractions, /lottieSeen/);
  assert.doesNotMatch(recordInteractions, /await search\.press\('x'\)/);
});
