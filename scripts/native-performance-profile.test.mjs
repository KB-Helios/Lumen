import assert from 'node:assert/strict';
import {test} from 'node:test';
import {admitFixturePage, ownedDescendants} from './native-performance-profile.mjs';

test('fixture attachment refuses ordinary or missing native markers', async () => {
  await assert.rejects(admitFixturePage({url: () => 'http://localhost:1420/', evaluate: async () => true}), /fixture URL/);
  await assert.rejects(admitFixturePage({url: () => 'http://localhost:1420/scripts/native-performance.html', evaluate: async () => false}), /native marker/);
  await admitFixturePage({url: () => 'http://localhost:1420/scripts/native-performance.html', evaluate: async () => true});
});

test('process ownership includes only descendants of the launched executable', () => {
  assert.deepEqual([...ownedDescendants([{ProcessId: 3, ParentProcessId: 2}, {ProcessId: 2, ParentProcessId: 1}, {ProcessId: 9, ParentProcessId: 8}], 1)].sort(), [1, 2, 3]);
});
