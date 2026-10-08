import * as rivetWasm from '@rivetkit/rivetkit-wasm';
import rivetWasmPath from '@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm' with {type: 'file'};
import {actor, setup} from 'rivetkit';
import {createClient} from 'rivetkit/client';
import {db} from 'rivetkit/db';
import {improvementAdvanceSchema, improvementFinishSchema, improvementJobSchema, improvementLeaseSchema, improvementQueueSql} from './improvement-queue';

interface EnrichmentJob {
  idempotencyKey: string;
  fileId: string;
  contentHash: string;
  kind: 'ocr' | 'transcription' | 'embedding';
  route: string;
}

const enrichmentQueue = actor({
  db: db({
    onMigrate: async (database) => {
      await database.execute(`
        CREATE TABLE IF NOT EXISTS jobs (
          idempotency_key TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          kind TEXT NOT NULL,
          route TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )
      `);
      await database.execute(improvementQueueSql.migrate);
    },
  }),
  actions: {
    enqueue: async (context, job: EnrichmentJob) => {
      await context.db.execute(
        `INSERT OR IGNORE INTO jobs
         (idempotency_key, file_id, content_hash, kind, route, status, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?)`,
        job.idempotencyKey,
        job.fileId,
        job.contentHash,
        job.kind,
        job.route,
        Date.now(),
      );
      return {accepted: true, idempotencyKey: job.idempotencyKey};
    },
    lease: async (context) => {
      const rows = await context.db.execute<EnrichmentJob & {status: string; attempts: number}>(
        `SELECT idempotency_key AS idempotencyKey, file_id AS fileId,
                content_hash AS contentHash, kind, route, status, attempts
         FROM jobs WHERE status = 'queued' ORDER BY updated_at LIMIT 1`,
      );
      const job = rows[0];
      if (!job) return null;
      await context.db.execute(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
         WHERE idempotency_key = ? AND status = 'queued'`,
        Date.now(),
        job.idempotencyKey,
      );
      return job;
    },
    complete: async (context, idempotencyKey: string) => {
      await context.db.execute(
        `UPDATE jobs SET status = 'completed', updated_at = ? WHERE idempotency_key = ?`,
        Date.now(),
        idempotencyKey,
      );
    },
    resumeInterrupted: async (context) => {
      await context.db.execute(
        `UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'`,
        Date.now(),
      );
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
registry.start();

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
        return Response.json(await queue.enqueue(await request.json() as EnrichmentJob));
      }
      if (request.method === 'POST' && path === '/jobs/lease') {
        return Response.json(await queue.lease());
      }
      if (request.method === 'POST' && path === '/jobs/resume') {
        await queue.resumeInterrupted();
        return Response.json({resumed: true});
      }
      if (request.method === 'POST' && path.startsWith('/jobs/') && path.endsWith('/complete')) {
        const id = decodeURIComponent(path.slice('/jobs/'.length, -'/complete'.length));
        await queue.complete(id);
        return Response.json({completed: true});
      }
      return Response.json({error: 'not_found'}, {status: 404});
    } catch {
      return Response.json({error: 'worker_failed'}, {status: 500});
    }
  },
});
