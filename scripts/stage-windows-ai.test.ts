import {expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, rm, rmdir, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replaceStagedDirectory, verifyOwnedTree} from './stage-windows-ai';

test('verified replacement removes stale DLLs and uses the fresh candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumen-stable-stage-'));
  try {
    const previous = join(root, 'windows-ai');
    const fresh = join(root, 'fresh');
    await mkdir(previous); await mkdir(fresh);
    await writeFile(join(previous, 'Microsoft.Windows.AI.Speech.Projection.dll'), 'stale');
    await writeFile(join(fresh, 'lumen-windows-ai.exe'), 'fresh');
    await replaceStagedDirectory(root, fresh, previous);
    expect(await readFile(join(previous, 'lumen-windows-ai.exe'), 'utf8')).toBe('fresh');
    expect(await Bun.file(join(previous, 'Microsoft.Windows.AI.Speech.Projection.dll')).exists()).toBe(false);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('staging rejects outside paths and reparse directories before replacing anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumen-stable-stage-'));
  const external = await mkdtemp(join(tmpdir(), 'lumen-stable-external-'));
  try {
    await writeFile(join(external, 'sentinel'), 'preserved');
    const candidate = join(root, 'fresh'); await mkdir(candidate);
    const previous = join(root, 'windows-ai');
    await symlink(external, previous, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(verifyOwnedTree(root, external)).rejects.toThrow();
    await expect(replaceStagedDirectory(root, candidate, previous)).rejects.toThrow();
    expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe('preserved');
    await rmdir(previous); // Remove only the known junction, never its target.
  } finally { await rm(root, {recursive:true, force:true}); await rm(external, {recursive:true, force:true}); }
});

test('an absent destination outside the owned root is rejected before moving the candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumen-stable-stage-'));
  const external = await mkdtemp(join(tmpdir(), 'lumen-stable-external-'));
  try {
    const candidate = join(root, 'fresh'); await mkdir(candidate);
    await writeFile(join(candidate, 'sentinel'), 'preserved');
    await expect(replaceStagedDirectory(root, candidate, join(external, 'absent'))).rejects.toThrow();
    expect(await readFile(join(candidate, 'sentinel'), 'utf8')).toBe('preserved');
  } finally { await rm(root, {recursive:true, force:true}); await rm(external, {recursive:true, force:true}); }
});
