import {Database} from 'bun:sqlite';
import {expect, test} from 'bun:test';
import {enrichmentJobSchema, enrichmentQueueSql as sql} from './enrichment-queue';

test('enrichment leases recover only on expiry and fence duplicates and old acknowledgments', () => {
  const db = new Database(':memory:');
  try {
    db.exec(sql.migrate);
    const args = ['file:hash:ocr:lumen.vision.cloud', 'file', 'a'.repeat(64), 'ocr', 'lumen.vision.cloud', 100];
    db.query(sql.enqueue).run(...args); db.query(sql.enqueue).run(...args);
    const first = db.query(sql.lease).get(100, Date.now() + 5000) as {generation: number; attempts: number};
    expect(first).toMatchObject({generation: 1, attempts: 1});
    expect(db.query(sql.lease).get(101, Date.now() + 5000)).toBeNull();
    db.query(sql.resumeExpired).run(200, 200);
    expect(db.query(sql.lease).get(200, Date.now() + 5000)).toBeNull();
    db.query(sql.resumeExpired).run(30_101, 30_101);
    const second = db.query(sql.lease).get(30_101, Date.now() + 5000) as {generation: number};
    expect(second.generation).toBe(2);
    expect(db.query(sql.finish).get('completed', 30_102, 30_102, args[0], 1, 30_102)).toBeNull();
    expect(db.query(sql.heartbeat).get(30_102, 30_102, args[0], 2, 30_102)).not.toBeNull();
    expect(db.query(sql.finish).get('completed', 30_103, 30_103, args[0], 2, 30_103)).not.toBeNull();
    expect(db.query('SELECT count(*) AS count FROM jobs').get()).toEqual({count: 1});
  } finally {db.close();}
});

test('retries have bounded backoff and exhaustion survives consumer crashes', () => {
  const db = new Database(':memory:');
  try {
    db.exec(sql.migrate);
    db.query(sql.enqueue).run('retry', 'file', 'a'.repeat(64), 'ocr', 'lumen.vision.cloud', 0);
    for (let generation = 1; generation <= 3; generation++) {
      const now = generation * 100_000;
      expect(db.query(sql.lease).get(now, Date.now() + 5000)).toMatchObject({generation, attempts: generation});
      expect(db.query(sql.finish).get('queued', now, now, 'retry', generation, now)).not.toBeNull();
      expect(db.query(sql.lease).get(now + 1, Date.now() + 5000)).toBeNull();
    }
    expect(db.query('SELECT status FROM jobs').get()).toEqual({status: 'failed'});
  } finally {db.close();}
});

test('queue admits only bounded hashes and fixed vision/audio routes, without payload or credentials', () => {
  const job = {idempotencyKey: 'key', fileId: 'file', contentHash: 'a'.repeat(64), kind: 'ocr', route: 'lumen.vision.cloud'};
  expect(enrichmentJobSchema.safeParse(job).success).toBe(true);
  for (const changed of [{...job, credential: 'secret'}, {...job, contentHash: 'bad'}, {...job, kind: 'embedding'}, {...job, route: 'arbitrary'}, {...job, fileId: 'x'.repeat(1025)}]) {
    expect(enrichmentJobSchema.safeParse(changed).success).toBe(false);
  }
});

test('activity pause releases a lease without consuming its retry budget', () => {
  const db = new Database(':memory:');
  try {
    db.exec(sql.migrate);
    db.query(sql.enqueue).run('pause', 'file', 'a'.repeat(64), 'ocr', 'lumen.vision.cloud', 0);
    db.query(sql.lease).get(100, Date.now() + 5000);
    expect(db.query(sql.finish).get('deferred', 101, 101, 'pause', 1, 101)).not.toBeNull();
    expect(db.query(sql.lease).get(102, Date.now() + 5000)).toMatchObject({generation: 2, attempts: 1});
  } finally {db.close();}
});

test('third crashed lease becomes a bounded failure batch for native status reconciliation', () => {
  const db = new Database(':memory:');
  try {
    db.exec(sql.migrate); db.query(sql.enqueue).run('crash','file','a'.repeat(64),'ocr','lumen.vision.cloud',0);
    for (let generation=1;generation<=3;generation++) {
      const now=generation*100000;
      expect(db.query(sql.lease).get(now,Date.now()+5000)).toMatchObject({generation,attempts:generation});
      db.query(sql.resumeExpired).run(now+30001,now+30001);
    }
    expect(db.query(sql.lease).get(500000,Date.now()+5000)).toBeNull();
    expect(db.query(sql.failed).all()).toEqual([{idempotencyKey:'crash',fileId:'file',contentHash:'a'.repeat(64),kind:'ocr',route:'lumen.vision.cloud'}]);
    db.query(sql.retain).run('[]'); expect(db.query('SELECT count(*) AS count FROM jobs').get()).toEqual({count:0});
  } finally {db.close();}
});
