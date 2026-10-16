import {expect, test} from 'bun:test';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageRivetEngine} from './stage-rivet-engine';

test('stages only the checked-in pinned engine and refuses a corrupted compressed input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumen-rivet-stage-'));
  const output = join(directory, 'engine.exe');
  const source = join(import.meta.dirname, '../vendor/rivet-engine/rivet-engine-2.3.10.exe.gz');
  await writeFile(output, 'previous');
  const corrupted = join(directory, 'corrupted.gz');
  await writeFile(corrupted, 'invalid compressed executable');
  await expect(stageRivetEngine(output, corrupted)).rejects.toThrow('checksum');
  expect((await readFile(output)).toString()).toBe('previous');
  await stageRivetEngine(output, source);
  expect((await readFile(output)).byteLength).toBe(86179438);
  // A locally tampered staged binary must be replaced by the pinned input.
  await writeFile(output, 'tampered');
  await stageRivetEngine(output, source);
  expect((await readFile(output)).byteLength).toBe(86179438);
});
