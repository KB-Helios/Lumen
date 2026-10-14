import assert from 'node:assert/strict';
import {test} from 'node:test';
import {admitFixturePage, measure, ownedDescendants} from './native-performance-profile.mjs';
import {sampleFrameCadence} from '../src/features/diagnostics/diagnostics.refresh.mjs';

test('fixture attachment refuses ordinary or missing native markers', async () => {
  await assert.rejects(admitFixturePage({url: () => 'http://localhost:1420/', evaluate: async () => true}), /fixture URL/);
  await assert.rejects(admitFixturePage({url: () => 'http://localhost:1420/scripts/native-performance.html', evaluate: async () => false}), /native marker/);
  await admitFixturePage({url: () => 'http://localhost:1420/scripts/native-performance.html', evaluate: async () => true});
});

test('process ownership includes only descendants of the launched executable', () => {
  assert.deepEqual([...ownedDescendants([{ProcessId: 3, ParentProcessId: 2}, {ProcessId: 2, ParentProcessId: 1}, {ProcessId: 9, ParentProcessId: 8}], 1)].sort(), [1, 2, 3]);
});

test('ordinary queries repeat a settled report after input sampling and cadence', async () => {
  const stop = new Error('Ordinary phase observed');
  let query = '';
  let metrics = {reactCommits: [], browserLongTasks: [], timings: []};
  let pending = false;
  let inputRead = false;
  const queryReads = [];
  const cadenceStates = [];
  const flush = () => {
    if (pending) { metrics.reactCommits.push(7); metrics.browserLongTasks.push(53); pending = false; }
  };
  const search = {
    waitFor: async () => {},
    fill: async (value) => { pending = pending || value !== query; query = value; },
  };
  const page = {
    getByRole: (role) => role === 'searchbox' ? search : {waitFor: async () => flush()},
    waitForFunction: async () => {},
    waitForTimeout: async () => flush(),
    evaluate: async (callback) => {
      if (callback === sampleFrameCadence) { cadenceStates.push({query, inputRead, pending}); flush(); return {intervals: [4], p95Ms: 4}; }
      const source = callback.toString();
      if (source.includes('__LUMEN_DIAGNOSTICS__.reset')) { metrics = {reactCommits: [], browserLongTasks: [], timings: []}; return; }
      if (source.includes('__LUMEN_DIAGNOSTICS__.read')) {
        if (!inputRead) { inputRead = true; return globalThis.structuredClone(metrics); }
        queryReads.push({query, ...globalThis.structuredClone(metrics)});
        if (queryReads.length === 24) throw stop;
        return globalThis.structuredClone(metrics);
      }
      if (source.includes('native_performance_status')) return {fixture: 'offline-ui-memory', foregroundUnchanged: true, visible: true};
      return {visibility: 'visible'};
    },
  };
  await assert.rejects(measure(page, 'unused-before-selection'), (error) => error === stop);
  assert.equal(queryReads.length, 24);
  assert.deepEqual(queryReads.map(({query}) => query), Array.from({length: 24}, (_, index) => ['report', 'design', 'project', ''][index % 4]));
  // A repeated settled value causes no new query commit, unlike report-30 -> report.
  assert.deepEqual(queryReads[0].reactCommits, []);
  assert.deepEqual(queryReads[1].reactCommits, [7]);
  assert.deepEqual(queryReads[1].browserLongTasks, [53]);
  assert.deepEqual(cadenceStates, [{query: 'report', inputRead: true, pending: false}]);
});
