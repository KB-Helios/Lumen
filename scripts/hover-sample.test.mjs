import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {measureHoverSample} from './lib/hover-sample.mjs';

// A deterministic renderer boundary: nominal timestamps lag callback entry by
// different amounts. The element models the observable state/style contract.
async function sampleFixture({missingState = false, missingStyle = false, staleReset = false} = {}) {
  let now = 0;
  let nominal = 0;
  let hovered = staleReset;
  let background = 'transparent';
  const frames = [];
  const element = {
    ownerDocument: {createElement: () => ({style: {}, remove() {}})},
    append() {},
    hasAttribute: () => hovered,
    dispatchEvent: ({type}) => {
      now += 1;
      if (type === 'pointerout' && !staleReset) hovered = false;
      if (type === 'pointerover' && !missingState) hovered = true;
      background = hovered && !missingStyle ? 'rgb(25, 25, 25)' : 'transparent';
    },
  };
  const sandbox = {
    element,
    performance: {now: () => now},
    requestAnimationFrame: (callback) => frames.push(callback),
    PointerEvent: class {constructor(type) {this.type = type;}},
    getComputedStyle: (target) => ({
      backgroundColor: target === element ? background : 'rgb(25, 25, 25)',
      getPropertyValue: () => 'rgb(25, 25, 25)',
    }),
  };
  const result = vm.runInNewContext(`(${measureHoverSample.toString()})(element)`, sandbox);
  // Microtasks commit before each next renderer callback.
  for (let frame = 0; frame < 10; frame += 1) {
    await Promise.resolve();
    if (!frames.length) continue;
    nominal += 16;
    now = nominal + (frame % 2 === 0 ? 1 : 5);
    await frames.shift()(nominal);
  }
  return result;
}

test('uses actual callback endpoints while retaining nominal cadence separately', async () => {
  const result = await sampleFixture();
  assert.equal(result.responseMs, 20);
  assert.equal(result.callbackIntervalMs, 20);
  assert.equal(result.nominalFrameIntervalMs, 16);
  assert.equal(result.startCallbackOffsetMs, 1);
  assert.equal(result.endCallbackOffsetMs, 5);
  assert.equal(result.ready, true);
});

for (const failure of ['missingState', 'missingStyle', 'staleReset']) {
  test(`rejects ${failure} independently of callback timing`, async () => {
    const result = await sampleFixture({[failure]: true});
    assert.equal(result.ready, false);
  });
}
