import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import test from 'node:test';

import {finishNativeAnswerProcess} from './lib/answer-native-shutdown.mjs';

async function childAfterEof(code, delayMs = 30) {
  const child = spawn(process.execPath, ['-e', `process.stdin.resume(); process.stdout.write('ready'); process.stdin.on('end', () => setTimeout(() => process.exit(${code}), ${delayMs}));`],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
  await once(child.stdout, 'data');
  return child;
}

async function dispose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('fails the gate when native final assertions exit nonzero after EOF', async () => {
  const child = await childAfterEof(7);
  try {
    await assert.rejects(Promise.resolve(finishNativeAnswerProcess(child)), /exited.*7/i);
    assert.equal(child.exitCode, 7);
    assert.equal(child.killed, false);
  } finally { await dispose(child); }
});

test('waits for delayed clean shutdown instead of killing the native process', async () => {
  const child = await childAfterEof(0, 60);
  try {
    const result = await finishNativeAnswerProcess(child);
    assert.equal(child.exitCode, 0);
    assert.equal(child.killed, false);
    assert.equal(result.code, 0);
    assert.ok(result.elapsedMs >= 40);
  } finally { await dispose(child); }
});

test('bounded shutdown kills only its owned stalled child and fails the gate', async () => {
  const owned = await childAfterEof(0, 10_000);
  const other = await childAfterEof(0, 10_000);
  try {
    const began = performance.now();
    await assert.rejects(Promise.resolve(finishNativeAnswerProcess(owned, 50)), /shutdown.*timed out/i);
    assert.ok(performance.now() - began < 1500);
    assert.equal(owned.killed, true);
    assert.equal(other.exitCode, null);
    assert.equal(other.killed, false);
  } finally { await dispose(owned); await dispose(other); }
});

test('rejects a process that already exited unsuccessfully', async () => {
  const child = await childAfterEof(3);
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
  await assert.rejects(Promise.resolve(finishNativeAnswerProcess(child)), /exited.*3/i);
});
