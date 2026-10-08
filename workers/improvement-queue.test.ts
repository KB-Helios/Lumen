import {Database} from 'bun:sqlite';
import {afterEach, expect, test} from 'bun:test';
import {improvementJobSchema, improvementQueueSql} from './improvement-queue';

const databases: Database[] = [];
function database() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(improvementQueueSql.migrate);
  return db;
}
const job = {idempotencyKey: 'job-1', baseVersion: 0, configDigest: 'a'.repeat(64), phase: 'analysis', candidateId: null};
function enqueue(db: Database) {db.query(improvementQueueSql.enqueue).run(job.idempotencyKey, job.baseVersion, job.configDigest, job.phase, null, 100);}
afterEach(() => {for (const db of databases.splice(0)) db.close();});

test('independent improvement queue validates allowlisted metadata and is idempotent', () => {
  expect(improvementJobSchema.safeParse({...job, prompt: 'private'}).success).toBe(false);
  const db = database(); enqueue(db); enqueue(db);
  expect(db.query('SELECT count(*) AS count FROM improvement_jobs').get()).toEqual({count: 1});
});
test('leases are atomic, fenced and only expired work is resumed', () => {
  const db = database(); enqueue(db);
  const first = db.query(improvementQueueSql.lease).get(1000, 1000) as {generation: number};
  expect(first.generation).toBe(1);
  expect(db.query(improvementQueueSql.lease).get(1001, 1001)).toBeNull();
  db.query(improvementQueueSql.resumeExpired).run(2000, 2000);
  expect(db.query(improvementQueueSql.lease).get(2000, 2000)).toBeNull();
  db.query(improvementQueueSql.resumeExpired).run(32_000, 32_000);
  const second = db.query(improvementQueueSql.lease).get(32_000, 32_000) as {generation: number};
  expect(second.generation).toBe(2);
  expect(db.query(improvementQueueSql.finish).get('completed', 32_001, 'job-1', 1, 32_001)).toBeNull();
  expect(db.query(improvementQueueSql.finish).get('completed', 32_001, 'job-1', 2, 32_001)).not.toBeNull();
});
