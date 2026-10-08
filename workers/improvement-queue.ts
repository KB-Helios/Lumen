import {z} from 'zod';

const identity = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/);
export const improvementJobSchema = z.object({
  idempotencyKey: identity,
  baseVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['analysis', 'generation', 'evaluation']),
  candidateId: identity.nullable(),
}).strict();
export const improvementLeaseSchema = z.object({idempotencyKey: identity, generation: z.number().int().positive()}).strict();
export const improvementAdvanceSchema = improvementLeaseSchema.extend({phase: improvementJobSchema.shape.phase, candidateId: identity.nullable()}).strict();
export const improvementFinishSchema = improvementLeaseSchema.extend({status: z.enum(['completed', 'failed', 'cancelled', 'queued'])}).strict();

// UPDATE RETURNING performs selection and admission in one SQLite statement.
// Old generations cannot heartbeat, advance or complete a recovered lease.
export const improvementQueueSql = {
  migrate: `CREATE TABLE IF NOT EXISTS improvement_jobs (
    idempotency_key TEXT PRIMARY KEY, base_version INTEGER NOT NULL,
    config_digest TEXT NOT NULL, phase TEXT NOT NULL, candidate_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued', generation INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  enqueue: `INSERT OR IGNORE INTO improvement_jobs
    (idempotency_key,base_version,config_digest,phase,candidate_id,updated_at) VALUES (?,?,?,?,?,?)`,
  lease: `UPDATE improvement_jobs SET status='running',generation=generation+1,lease_until=?+30000,updated_at=?
    WHERE idempotency_key=(SELECT idempotency_key FROM improvement_jobs WHERE status='queued' ORDER BY updated_at LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM improvement_jobs WHERE status='running')
    RETURNING idempotency_key AS idempotencyKey,base_version AS baseVersion,config_digest AS configDigest,
    phase,candidate_id AS candidateId,generation`,
  heartbeat: `UPDATE improvement_jobs SET lease_until=?+30000,updated_at=? WHERE idempotency_key=? AND generation=? AND status='running' AND lease_until>=?
    RETURNING generation`,
  advance: `UPDATE improvement_jobs SET phase=?,candidate_id=?,updated_at=? WHERE idempotency_key=? AND generation=? AND status='running' AND lease_until>=?
    RETURNING generation`,
  finish: `UPDATE improvement_jobs SET status=?,lease_until=0,updated_at=? WHERE idempotency_key=? AND generation=? AND status='running' AND lease_until>=?
    RETURNING generation`,
  resumeExpired: `UPDATE improvement_jobs SET status='queued',lease_until=0,updated_at=? WHERE status='running' AND lease_until<?`,
  clear: `DELETE FROM improvement_jobs`,
};
