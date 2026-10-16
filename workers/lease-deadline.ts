import {z} from 'zod';

type LeaseDatabase = {execute: (sql: string, ...parameters: number[]) => Promise<unknown[]>};
type LeaseSql = {resumeExpired: string; lease: string};

export async function leaseBeforeDeadline(database: LeaseDatabase, sql: LeaseSql, input: unknown) {
  const deadline = z.number().int().positive().parse(input);
  let now = Date.now();
  if (deadline < now || deadline > now + 5000) return null;
  await database.execute(sql.resumeExpired, now, now);
  now = Date.now();
  if (deadline < now) return null;
  // Remote SQL can wait after this check. Its atomic UPDATE also checks the
  // deadline against SQLite's execution clock before consuming a generation.
  const rows = await database.execute(sql.lease, now, deadline);
  return rows[0] ?? null;
}
