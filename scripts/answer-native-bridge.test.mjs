import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {request as httpRequest} from 'node:http';
import {once} from 'node:events';
import test from 'node:test';

import {createAnswerNativeBridge} from './lib/answer-native-bridge.mjs';

test('native bridge streams events before completion and cancels abandoned requests', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const commands = [];
  stdin.on('data', (chunk) => commands.push(JSON.parse(chunk.toString())));
  const bridge = await createAnswerNativeBridge({stdin, stdout});
  try {
    const response = await new Promise((resolve) => {
      const request = httpRequest(`${bridge.url}/start`, {
        method: 'POST', headers: {'content-type': 'application/json', 'x-lumen-test-token': bridge.token},
      }, resolve);
      request.end(JSON.stringify({requestId: 1, query: 'stall', mode: 'local', cloudConsent: false}));
    });
    assert.equal(response.statusCode, 200);
    const received = once(response, 'data');
    stdout.write('test runner informational line\n');
    stdout.write('{"requestId":1,"event":{"type":"delta","text":"native token"}}\n');
    assert.match((await received)[0].toString(), /native token/);
    assert.equal(bridge.activeRequests, 1);
    response.destroy();
    for (let attempt = 0; attempt < 50 && commands.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(commands[0], {command: 'start', request: {requestId: 1, query: 'stall', mode: 'local', cloudConsent: false}});
    assert.deepEqual(commands[1], {command: 'cancel', requestId: 1});
    assert.equal(bridge.activeRequests, 0);
  } finally { await bridge.close(); }
});

test('native bridge requires a private token and does not forward unsupported input', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let writes = 0;
  stdin.on('data', () => writes++);
  const bridge = await createAnswerNativeBridge({stdin, stdout});
  try {
    const denied = await fetch(`${bridge.url}/start`, {method: 'POST', body: '{}'});
    assert.equal(denied.status, 403);
    const invalid = await fetch(`${bridge.url}/start`, {
      method: 'POST', headers: {'x-lumen-test-token': bridge.token}, body: JSON.stringify({requestId: 2, query: 'anything', mode: 'local'}),
    });
    assert.equal(invalid.status, 400);
    const invalidNull = await fetch(`${bridge.url}/start`, {method: 'POST', headers: {'x-lumen-test-token': bridge.token}, body: 'null'});
    assert.equal(invalidNull.status, 400);
    assert.equal(writes, 0);
  } finally { await bridge.close(); }
});

test('native bridge ends a request only after the matching native done record', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const bridge = await createAnswerNativeBridge({stdin, stdout});
  try {
    const response = await fetch(`${bridge.url}/start`, {
      method: 'POST', headers: {'x-lumen-test-token': bridge.token},
      body: JSON.stringify({requestId: 3, query: 'failure', mode: 'local', cloudConsent: false}),
    });
    stdout.write('{"requestId":999,"done":true}\n');
    assert.equal(bridge.activeRequests, 1);
    stdout.write('{"requestId":3,"event":{"type":"failed","message":"Fixture failure"}}\n');
    stdout.write('{"requestId":3,"done":true}\n');
    assert.match(await response.text(), /Fixture failure/);
    assert.equal(bridge.activeRequests, 0);
  } finally { await bridge.close(); }
});
