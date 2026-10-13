import {z} from 'zod';
export const enrichmentJobSchema = z.object({
  idempotencyKey: z.string().min(1).max(2048), fileId: z.string().min(1).max(1024),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['ocr', 'transcription']),
  route: z.enum(['lumen.vision.cloud', 'lumen.audio.cloud']),
}).strict().refine(job => job.route === (job.kind === 'ocr' ? 'lumen.vision.cloud' : 'lumen.audio.cloud'));
export const enrichmentLeaseSchema = z.object({idempotencyKey: z.string().min(1).max(2048), generation: z.number().int().positive()}).strict();
export const enrichmentFinishSchema = enrichmentLeaseSchema.extend({status: z.enum(['completed', 'queued', 'cancelled', 'deferred'])}).strict();
export const enrichmentQueueSql = {
  migrate: `CREATE TABLE IF NOT EXISTS jobs(idempotency_key TEXT PRIMARY KEY,file_id TEXT NOT NULL,content_hash TEXT NOT NULL,kind TEXT NOT NULL,route TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,not_before INTEGER NOT NULL DEFAULT 0)`,
  enqueue: `INSERT OR IGNORE INTO jobs(idempotency_key,file_id,content_hash,kind,route,updated_at) VALUES(?,?,?,?,?,?)`,
  lease: `UPDATE jobs SET status='running',attempts=attempts+1,generation=generation+1,lease_until=?+30000,updated_at=?
    WHERE idempotency_key=(SELECT idempotency_key FROM jobs WHERE status='queued' AND attempts<3 AND not_before<=? ORDER BY updated_at LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM jobs WHERE status='running')
    RETURNING idempotency_key AS idempotencyKey,file_id AS fileId,content_hash AS contentHash,kind,route,generation,attempts`,
  resumeExpired: `UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,lease_until=0,updated_at=? WHERE status='running' AND lease_until<?`,
  heartbeat: `UPDATE jobs SET lease_until=?+30000,updated_at=? WHERE idempotency_key=? AND generation=? AND status='running' AND lease_until>=? RETURNING generation`,
  finish: `UPDATE jobs SET status=CASE WHEN ?='deferred' THEN 'queued' WHEN ?1='queued' AND attempts>=3 THEN 'failed' ELSE ?1 END,
    attempts=CASE WHEN ?1='deferred' THEN MAX(0,attempts-1) ELSE attempts END,
    lease_until=0,not_before=?+CASE WHEN ?1='deferred' THEN 0 WHEN attempts=1 THEN 5000 ELSE 10000 END,updated_at=? WHERE idempotency_key=? AND generation=? AND status='running' AND lease_until>=? RETURNING generation`,
  retain: `DELETE FROM jobs WHERE idempotency_key NOT IN (SELECT value FROM json_each(?))`,
  failed: `SELECT idempotency_key AS idempotencyKey,file_id AS fileId,content_hash AS contentHash,kind,route FROM jobs WHERE status='failed' ORDER BY updated_at LIMIT 128`,
};
