import {Database} from 'bun:sqlite';
import {expect, test} from 'bun:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {enrichmentQueueSql} from './enrichment-queue';
import {improvementQueueSql} from './improvement-queue';

// Evaluate the actual registered action bodies without launching the owned servers.
// Only the worker bootstrap after the actor definition is omitted; SQL is real.
const source = join(import.meta.dirname, 'enrichment-worker.ts');
const directory = await mkdtemp(join(tmpdir(), 'lumen-lease-actions-'));
const build = await Bun.build({entrypoints: [source], target: 'bun', plugins: [{name: 'actor-only-fixture', setup(builder) {
  builder.onLoad({filter: /enrichment-worker\.ts$/}, async () => {
    const contents = await readFile(source, 'utf8');
    const bootstrap = contents.indexOf('\nconst actorPort =');
    if (bootstrap < 0) throw new Error('Cannot safely isolate actor actions from worker bootstrap');
    return {loader: 'ts', resolveDir: dirname(source), contents: contents.slice(0, bootstrap) + '\nexport const actions = enrichmentQueue.config.actions;'};
  });
}}]});
if (!build.success) throw new AggregateError(build.logs, 'Could not load production lease actions');
const modulePath = join(directory, 'actions.js');
await Bun.write(modulePath, await build.outputs[0].text());
type Execute = (sql: string, ...parameters: number[]) => Promise<unknown[]>;
const {actions} = await import(modulePath) as {actions: Record<string, (context: {db: {execute: Execute}}, deadline: number) => Promise<unknown>>};
await rm(directory, {recursive: true, force: true});

for (const [name, sql, table] of [
  ['lease', enrichmentQueueSql, 'jobs'], ['leaseImprovement', improvementQueueSql, 'improvement_jobs'],
] as const) {
  test(`${name} starts a valid lease with the refreshed clock after cleanup`, async () => {
    const database = new Database(':memory:');
    try {
      database.exec(sql.migrate);
      const began = Date.now();
      if (table === 'jobs') database.query(sql.enqueue).run('owned', 'file', 'a'.repeat(64), 'ocr', 'lumen.vision.cloud', began);
      else database.query(sql.enqueue).run('owned', 0, 'a'.repeat(64), 'analysis', null, began);
      const execute: Execute = async (statement, ...parameters) => {
        if (statement === sql.resumeExpired) await Bun.sleep(50);
        return database.query(statement).all(...parameters);
      };
      expect(await actions[name]({db: {execute}}, began + 5000)).toMatchObject({generation: 1});
      const row = database.query(`SELECT updated_at,lease_until FROM ${table}`).get() as {updated_at: number; lease_until: number};
      expect(row.updated_at).toBeGreaterThanOrEqual(began + 40);
      expect(row.lease_until - row.updated_at).toBe(30000);
    } finally {database.close();}
  });
  for (const delayedOperation of ['cleanup', 'acquisition'] as const) {
    test(`${name} cannot acquire or consume a generation after delayed ${delayedOperation} crosses its deadline`, async () => {
      const database = new Database(':memory:');
      try {
        database.exec(sql.migrate);
        if (table === 'jobs') database.query(sql.enqueue).run('owned', 'file', 'a'.repeat(64), 'ocr', 'lumen.vision.cloud', Date.now());
        else database.query(sql.enqueue).run('owned', 0, 'a'.repeat(64), 'analysis', null, Date.now());
        const execute: Execute = async (statement, ...parameters) => {
          if (statement === (delayedOperation === 'cleanup' ? sql.resumeExpired : sql.lease)) await Bun.sleep(150);
          return database.query(statement).all(...parameters);
        };
        const result = await actions[name]({db: {execute}}, Date.now() + 100);
        expect(result).toBeNull();
        expect(database.query(`SELECT status,generation,lease_until FROM ${table}`).get()).toEqual({status: 'queued', generation: 0, lease_until: 0});
        if (table === 'jobs') expect(database.query('SELECT attempts FROM jobs').get()).toEqual({attempts: 0});
      } finally {database.close();}
    });
  }
}
