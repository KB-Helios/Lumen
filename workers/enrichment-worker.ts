import * as rivetWasm from '@rivetkit/rivetkit-wasm';
import rivetWasmPath from '@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm' with {type: 'file'};
import {actor, setup} from 'rivetkit';
import {createClient} from 'rivetkit/client';
import {db} from 'rivetkit/db';
import {z} from 'zod';
import {enrichmentJobSchema, enrichmentLeaseSchema, enrichmentFinishSchema, enrichmentQueueSql} from './enrichment-queue';
import {improvementAdvanceSchema, improvementFinishSchema, improvementJobSchema, improvementLeaseSchema, improvementQueueSql} from './improvement-queue';

const enrichmentQueue = actor({
  onBeforeConnect(context) {
    // The open-source engine routes actors without validating its gateway token.
    // Pool authentication identifies the engine, not the originating caller.
    if (context.request?.headers.get('authorization') !== `Bearer ${bearer}`) throw new Error('Unauthorized queue caller');
  },
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
    lease: async (context, input: unknown) => {
      const now = Date.now();
      const deadline = z.number().int().positive().parse(input);
      if (deadline < now || deadline > now + 5000) return null;
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
    leaseImprovement: async (context, input: unknown) => {
      const now = Date.now();
      const deadline = z.number().int().positive().parse(input);
      if (deadline < now || deadline > now + 5000) return null;
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
  wasm: {bindings: rivetWasm, initInput: {module_or_path: rivetWasmModule}},
  sqlite: 'remote',
  httpHost: '127.0.0.1',
  httpPort: actorPort,
  endpoint: `http://127.0.0.1:${enginePort}`,
  token: bearer,
  configurePool: {url: `http://127.0.0.1:${actorPort}/api/rivet`, headers: {'x-rivet-token': bearer}},
  serverless: {publicEndpoint: `http://127.0.0.1:${enginePort}`},
  startEngine: false,
  noWelcome: true,
  logging: {level: 'warn'},
});
Bun.serve({
  hostname: '127.0.0.1', port: actorPort,
  fetch(request) {
    if (request.headers.get('x-rivet-token') !== bearer) return Response.json({error: 'unauthorized'}, {status: 401});
    return registry.handler(request);
  },
});
// Metadata initializes the supported serverless runtime and registers its pool.
const metadata = await registry.handler(new Request(`http://127.0.0.1:${actorPort}/api/rivet/metadata`));
if (!metadata.ok) throw new Error('Rivet serverless pool could not be configured');

// HTTP gateway actions support x-rivet-token. The SDK's token option also puts
// the credential in actor URLs, which the engine logs on recovery warnings.
const client = createClient<typeof registry>({endpoint: `http://127.0.0.1:${enginePort}`, namespace: 'default',
  headers: {'x-rivet-token': bearer, authorization: `Bearer ${bearer}`}, disableMetadataLookup: true});
const queue = client.enrichmentQueue.getOrCreate(['lumen']);

Bun.serve({
  hostname: '127.0.0.1',
  port: controlPort,
  async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${bearer}`) {
      return Response.json({error: 'unauthorized'}, {status: 401});
    }
    const path = new URL(request.url).pathname;
    const action = (name: string, args: unknown[] = []) => queue.action({name, args,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]), skipReadyWait: true});
    try {
      if (request.method === 'GET' && path === '/health') {
        await action('status');
        return Response.json({status: 'ready'});
      }
      if (path === '/improvements' && request.method === 'POST') return Response.json(await action('enqueueImprovement', [await request.json()]));
      if (path === '/improvements/lease' && request.method === 'POST') return Response.json(await action('leaseImprovement', [Date.now() + 5000]));
      if (path === '/improvements/heartbeat' && request.method === 'POST') return Response.json(await action('heartbeatImprovement', [await request.json()]));
      if (path === '/improvements/advance' && request.method === 'POST') return Response.json(await action('advanceImprovement', [await request.json()]));
      if (path === '/improvements/finish' && request.method === 'POST') return Response.json(await action('finishImprovement', [await request.json()]));
      if (path === '/improvements' && request.method === 'DELETE') return Response.json(await action('clearImprovements'));
      if (request.method === 'GET' && path === '/jobs') {
        return Response.json(await action('status'));
      }
      if (request.method === 'POST' && path === '/jobs') {
        return Response.json(await action('enqueue', [await request.json()]));
      }
      if (request.method === 'POST' && path === '/jobs/lease') {
        return Response.json(await action('lease', [Date.now() + 5000]));
      }
      if (request.method === 'POST' && path === '/jobs/resume') {
        await action('resumeInterrupted');
        return Response.json({resumed: true});
      }
      if (request.method === 'POST' && path === '/jobs/heartbeat') return Response.json(await action('heartbeat', [await request.json()]));
      if (request.method === 'POST' && path === '/jobs/finish') return Response.json(await action('finish', [await request.json()]));
      if (request.method === 'POST' && path === '/jobs/retain') return Response.json(await action('retain', [await request.json()]));
      if (request.method === 'POST' && path === '/jobs/failed') return Response.json(await action('failed'));
      return Response.json({error: 'not_found'}, {status: 404});
    } catch {
      return Response.json({error: 'worker_failed'}, {status: 500});
    }
  },
});
