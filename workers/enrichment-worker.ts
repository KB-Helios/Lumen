import * as rivetWasm from '@rivetkit/rivetkit-wasm';
import rivetWasmPath from '@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm' with {type: 'file'};
import {actor, setup} from 'rivetkit';
import {createClient} from 'rivetkit/client';
import {db} from 'rivetkit/db';
import {enrichmentJobSchema, enrichmentLeaseSchema, enrichmentFinishSchema, enrichmentQueueSql} from './enrichment-queue';
import {improvementAdvanceSchema, improvementFinishSchema, improvementJobSchema, improvementLeaseSchema, improvementQueueSql} from './improvement-queue';

const enrichmentQueue = actor({
  db: db({
    onMigrate: async (database) => {
      await database.execute(enrichmentQueueSql.migrate);
      const columns = await database.execute<{name: string}>('PRAGMA table_info(jobs)');
      for (const name of ['generation', 'lease_until', 'not_before']) {
        if (!columns.some(column => column.name === name)) await database.execute(`ALTER TABLE jobs ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      }
      await database.execute(improvementQueueSql.migrate);
    },
  }),
  actions: {
    enqueue: async (context, input: unknown) => {
      const job = enrichmentJobSchema.parse(input);
      await context.db.execute(enrichmentQueueSql.enqueue, job.idempotencyKey, job.fileId, job.contentHash, job.kind, job.route, Date.now());
      return {accepted: true};
    },
    lease: async (context) => {
      const now = Date.now();
      await context.db.execute(enrichmentQueueSql.resumeExpired, now, now);
      const rows = await context.db.execute(enrichmentQueueSql.lease, now, now, now);
      return rows[0] ?? null;
    },
    heartbeat: async (context, input: unknown) => {
      const lease = enrichmentLeaseSchema.parse(input); const now = Date.now();
      const rows = await context.db.execute(enrichmentQueueSql.heartbeat, now, now, lease.idempotencyKey, lease.generation, now);
      return {accepted: rows.length === 1};
    },
    finish: async (context, input: unknown) => {
      const lease = enrichmentFinishSchema.parse(input); const now = Date.now();
      const rows = await context.db.execute(enrichmentQueueSql.finish, lease.status, now, now, lease.idempotencyKey, lease.generation, now);
      return {accepted: rows.length === 1};
    },
    retain: async (context, input: unknown) => {
      const keys = enrichmentLeaseSchema.shape.idempotencyKey.array().max(250000).parse(input);
      await context.db.execute(enrichmentQueueSql.retain, JSON.stringify(keys));
      return {accepted: true};
    },
    failed: async (context) => context.db.execute(enrichmentQueueSql.failed),
    resumeInterrupted: async (context) => {
      const now = Date.now();
      await context.db.execute(enrichmentQueueSql.resumeExpired, now, now);
    },
    status: async (context) => context.db.execute<{status: string; count: number}>(
      'SELECT status, count(*) AS count FROM jobs GROUP BY status ORDER BY status',
    ),
    enqueueImprovement: async (context, input: unknown) => {
      const job = improvementJobSchema.parse(input);
      await context.db.execute(improvementQueueSql.enqueue, job.idempotencyKey, job.baseVersion, job.configDigest, job.phase, job.candidateId, Date.now());
      return {accepted: true};
    },
    leaseImprovement: async (context) => {
      const now = Date.now();
      await context.db.execute(improvementQueueSql.resumeExpired, now, now);
      const rows = await context.db.execute(improvementQueueSql.lease, now, now);
      return rows[0] ?? null;
    },
    heartbeatImprovement: async (context, input: unknown) => {
      const lease = improvementLeaseSchema.parse(input); const now = Date.now();
      const rows = await context.db.execute(improvementQueueSql.heartbeat, now, now, lease.idempotencyKey, lease.generation, now);
      return {accepted: rows.length === 1};
    },
    advanceImprovement: async (context, input: unknown) => {
      const job = improvementAdvanceSchema.parse(input); const now = Date.now();
      const rows = await context.db.execute(improvementQueueSql.advance, job.phase, job.candidateId, now, job.idempotencyKey, job.generation, now);
      return {accepted: rows.length === 1};
    },
    finishImprovement: async (context, input: unknown) => {
      const job = improvementFinishSchema.parse(input);
      const now = Date.now();
      const rows = await context.db.execute(improvementQueueSql.finish, job.status, now, job.idempotencyKey, job.generation, now);
      return {accepted: rows.length === 1};
    },
    clearImprovements: async (context) => {await context.db.execute(improvementQueueSql.clear); return {cleared: true};},
  },
});

const actorPort = Number.parseInt(process.env.LUMEN_RIVET_PORT ?? '6420', 10);
const enginePort = Number.parseInt(process.env.LUMEN_RIVET_ENGINE_PORT ?? '6422', 10);
const controlPort = Number.parseInt(process.env.LUMEN_WORKER_CONTROL_PORT ?? '6421', 10);
const bearer = process.env.LUMEN_WORKER_BEARER;
if (!bearer) throw new Error('LUMEN_WORKER_BEARER is required');

// The wasm-bindgen default loader fetches its URL and retries a consumed
// Response when Bun's MIME type is not application/wasm. Supplying a compiled
// module keeps startup deterministic in the bundled Windows executable.
const rivetWasmModule = new WebAssembly.Module(await Bun.file(rivetWasmPath).arrayBuffer());

export const registry = setup({
  use: {enrichmentQueue},
  runtime: 'wasm',
  wasm: {bindings: rivetWasm, initInput: rivetWasmModule},
  sqlite: 'remote',
  httpHost: '127.0.0.1',
  httpPort: actorPort,
  endpoint: `http://127.0.0.1:${enginePort}`,
  startEngine: false,
  noWelcome: true,
  logging: {level: 'warn'},
});
await registry.start();

const client = createClient<typeof registry>(`http://127.0.0.1:${actorPort}`);
const queue = client.enrichmentQueue.getOrCreate(['lumen']);

Bun.serve({
  hostname: '127.0.0.1',
  port: controlPort,
  async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${bearer}`) {
      return Response.json({error: 'unauthorized'}, {status: 401});
    }
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/health') {
        await queue.status();
        return Response.json({status: 'ready'});
      }
      if (path === '/improvements' && request.method === 'POST') return Response.json(await queue.enqueueImprovement(await request.json()));
      if (path === '/improvements/lease' && request.method === 'POST') return Response.json(await queue.leaseImprovement());
      if (path === '/improvements/heartbeat' && request.method === 'POST') return Response.json(await queue.heartbeatImprovement(await request.json()));
      if (path === '/improvements/advance' && request.method === 'POST') return Response.json(await queue.advanceImprovement(await request.json()));
      if (path === '/improvements/finish' && request.method === 'POST') return Response.json(await queue.finishImprovement(await request.json()));
      if (path === '/improvements' && request.method === 'DELETE') return Response.json(await queue.clearImprovements());
      if (request.method === 'GET' && path === '/jobs') {
        return Response.json(await queue.status());
      }
      if (request.method === 'POST' && path === '/jobs') {
        return Response.json(await queue.enqueue(await request.json()));
      }
      if (request.method === 'POST' && path === '/jobs/lease') {
        return Response.json(await queue.lease());
      }
      if (request.method === 'POST' && path === '/jobs/resume') {
        await queue.resumeInterrupted();
        return Response.json({resumed: true});
      }
      if (request.method === 'POST' && path === '/jobs/heartbeat') return Response.json(await queue.heartbeat(await request.json()));
      if (request.method === 'POST' && path === '/jobs/finish') return Response.json(await queue.finish(await request.json()));
      if (request.method === 'POST' && path === '/jobs/retain') return Response.json(await queue.retain(await request.json()));
      if (request.method === 'POST' && path === '/jobs/failed') return Response.json(await queue.failed());
      return Response.json({error: 'not_found'}, {status: 404});
    } catch {
      return Response.json({error: 'worker_failed'}, {status: 500});
    }
  },
});
