import {expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, rm, rmdir, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replaceStagedDirectory, verifyOwnedDirectory, verifyOwnedTree} from './stage-windows-ai';

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

test('retained build siblings do not consume the bound for a new stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumen-stable-stage-'));
  try {
    const buildRoot = join(root, '.build');
    const retained = join(buildRoot, 'retained');
    await mkdir(retained, {recursive:true});
    for (let start = 0; start < 10001; start += 250) {
      await Promise.all(Array.from({length: Math.min(250, 10001 - start)}, (_, offset) =>
        writeFile(join(retained, String(start + offset)), '')));
    }
    const candidate = join(buildRoot, 'fresh');
    await mkdir(candidate);
    await writeFile(join(candidate, 'lumen-windows-ai.exe'), 'fresh');
    await verifyOwnedDirectory(root, buildRoot);
    await expect(verifyOwnedTree(root, retained)).rejects.toThrow('file bound');
    await replaceStagedDirectory(root, candidate, join(buildRoot, 'windows-ai'));
    expect(await readFile(join(buildRoot, 'windows-ai', 'lumen-windows-ai.exe'), 'utf8')).toBe('fresh');
    expect(await Bun.file(join(retained, '10000')).exists()).toBe(true);
  } finally { await rm(root, {recursive:true, force:true}); }
}, 30000);

test('ancestor and selected-tree reparse escapes are rejected before replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumen-stable-stage-'));
  const external = await mkdtemp(join(tmpdir(), 'lumen-stable-external-'));
  try {
    await writeFile(join(external, 'sentinel'), 'preserved');
    const candidate = join(root, 'fresh');
    const candidateForLinkedParent = join(root, 'fresh-parent');
    const previous = join(root, 'windows-ai');
    await mkdir(candidate);
    await mkdir(candidateForLinkedParent);
    await writeFile(join(candidateForLinkedParent, 'marker'), 'preserved');
    await mkdir(previous);
    await writeFile(join(previous, 'sentinel'), 'previous');
    const selectedLink = join(candidate, 'linked');
    const parentLink = join(root, 'linked-parent');
    await symlink(external, selectedLink, process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(external, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
    const fileParent = join(root, 'file-parent');
    await writeFile(fileParent, 'not a directory');
    await expect(verifyOwnedDirectory(root, fileParent)).rejects.toThrow('regular directories');
    await expect(verifyOwnedDirectory(root, parentLink)).rejects.toThrow();
    await expect(replaceStagedDirectory(root, candidateForLinkedParent, join(parentLink, 'windows-ai'))).rejects.toThrow();
    expect(await readFile(join(candidateForLinkedParent, 'marker'), 'utf8')).toBe('preserved');
    await expect(replaceStagedDirectory(root, candidate, previous)).rejects.toThrow();
    expect(await readFile(join(previous, 'sentinel'), 'utf8')).toBe('previous');
    expect(await readFile(join(external, 'sentinel'), 'utf8')).toBe('preserved');
    await rmdir(selectedLink);
    await rmdir(parentLink);
  } finally { await rm(root, {recursive:true, force:true}); await rm(external, {recursive:true, force:true}); }
});
