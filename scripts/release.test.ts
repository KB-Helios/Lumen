import {describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertCompiledBinding, assertInventory, assertSignature, assertSigningMutation, checkVersions, inventory, isPortableExecutable, preparePayload, validateArchivePaths} from './release';

describe('release trust boundaries', () => {
  it('requires package, Tauri, Cargo and optional tag to agree', () => {
    expect(checkVersions('0.1.0', '0.1.0', '[package]\nversion = "0.1.0"\n[dependencies]\nfoo = "2"', 'v0.1.0')).toBe('0.1.0');
    expect(() => checkVersions('0.1.0', '0.1.0', '[package]\nversion = "0.2.0"')).toThrow(/version/i);
    expect(() => checkVersions('0.1.0', '0.2.0', '[package]\nversion = "0.1.0"')).toThrow(/version/i);
    expect(() => checkVersions('0.1.0', '0.1.0', '[package]\nversion = "0.1.0"', 'v0.2.0')).toThrow(/tag/i);
  });

  it('detects PE bytes including PYD and refuses a DOS stub alone', () => {
    const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
    expect(isPortableExecutable(bytes)).toBe(true);
    expect(isPortableExecutable(Buffer.from('MZjust data'))).toBe(false);
  });

  it('allows only Authenticode header changes, alignment padding and appended signature bytes', () => {
    const original = Buffer.alloc(513); original.write('MZ'); original.writeUInt32LE(128,60); original.write('PE\0\0',128); original.writeUInt16LE(523,152);
    original[500] = 42;
    const signed = Buffer.concat([original,Buffer.alloc(7),Buffer.from('signature bytes!')]);
    signed.writeUInt32LE(123,216); signed.writeUInt32LE(520,296); signed.writeUInt32LE(16,300);
    expect(() => assertSigningMutation(original,signed)).not.toThrow();
    const changed = Buffer.from(signed); changed[500] ^= 1;
    expect(() => assertSigningMutation(original,changed)).toThrow(/mutation/i);
    const moved = Buffer.from(signed); moved.writeUInt32LE(512,296);
    expect(() => assertSigningMutation(original,moved)).toThrow(/mutation/i);
    expect(() => assertSigningMutation(signed,changed)).toThrow(/retained/i);
  });

  it('rejects stale signed native output when the seal or Gateway changes', () => {
    const current = `lumen-release-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`;
    expect(() => assertCompiledBinding(Buffer.from(`pe header ${current} rest`),current)).not.toThrow();
    expect(() => assertCompiledBinding(Buffer.from(current.replace('a'.repeat(64),'c'.repeat(64))),current)).toThrow(/binding/i);
    expect(() => assertCompiledBinding(Buffer.from(current.replace('b'.repeat(64),'c'.repeat(64))),current)).toThrow(/binding/i);
    expect(() => assertCompiledBinding(Buffer.from('unsigned upstream digest'),current)).toThrow(/binding/i);
  });

  it('requires trusted SHA256 timestamped signatures and exact approved identities', () => {
    const approved = {subject:'CN=fixture owner', thumbprint:'A'.repeat(40)};
    const valid = {...approved, status:'Valid', sha256:true, timestamped:true};
    expect(() => assertSignature(valid, [approved])).not.toThrow();
    for (const changed of [{status:'NotSigned'}, {sha256:false}, {timestamped:false}, {thumbprint:'B'.repeat(40)}, {subject:'CN=other'}]) {
      expect(() => assertSignature({...valid, ...changed}, [approved])).toThrow(/signature/i);
    }
    expect(() => assertSignature(valid, [])).toThrow(/signature/i);
    expect(() => assertSignature({...valid,signers:[approved,{subject:'CN=unexpected nested signer',thumbprint:'B'.repeat(40)}]}, [approved])).toThrow(/signature/i);
  });

  it('preserves original bytes before mutation and seals only the final signed copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumen-release-test-'));
    try {
      const staged = join(root, 'payload.pyd'); await writeFile(staged, 'upstream verified');
      const mapping = {'nested/payload.pyd':staged};
      let signingCalled = false;
      const result = await preparePayload(mapping, join(root, 'originals'), async path => {
        expect((await readFile(join(root, 'originals/nested/payload.pyd'))).toString()).toBe('upstream verified');
        signingCalled = true; await writeFile(path, 'final signed bytes');
      });
      expect(signingCalled).toBe(true);
      expect(result.original['nested/payload.pyd'].sha256).not.toBe(result.final['nested/payload.pyd'].sha256);
      await assertInventory(mapping, result.final);
      await writeFile(staged, 'tampered');
      await expect(assertInventory(mapping, result.final)).rejects.toThrow(/seal/i);
      await expect(assertInventory({}, result.final)).rejects.toThrow(/seal/i);
      await expect(assertInventory({...mapping, extra:staged}, result.final)).rejects.toThrow(/seal/i);
    } finally { await rm(root, {recursive:true, force:true}); }
  });

  it('rejects colliding installed paths and captures non-PE resources too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumen-release-test-'));
    try {
      await mkdir(join(root, 'data')); const file = join(root, 'data/file.txt'); await writeFile(file, 'owned data');
      expect(Object.keys(await inventory({'data/file.txt':file}))).toEqual(['data/file.txt']);
      await expect(inventory({'x.dll':file, 'X.dll':file})).rejects.toThrow(/collision/i);
    } finally { await rm(root, {recursive:true, force:true}); }
  });

  it('rejects archive traversal and overwrite collisions before extraction', () => {
    expect(validateArchivePaths('Path = lumen.exe\nSize = 10\n\nPath = $PLUGINSDIR/System.dll\nSize = 20\n')).toEqual(['lumen.exe','$PLUGINSDIR/System.dll']);
    for (const name of ['../outside.exe','C:/outside.exe','/outside.exe','a/../outside.exe','a:stream','.. /outside.exe','a./file.exe']) {
      expect(() => validateArchivePaths(`Path = ${name}\nSize = 10\n`)).toThrow(/archive/i);
    }
    expect(() => validateArchivePaths('Path = x.dll\nSize = 1\n\nPath = X.dll\nSize = 2\n')).toThrow(/archive/i);
    expect(() => validateArchivePaths('')).toThrow(/archive/i);
  });

  it('retains original provenance when signing fails and never returns a final seal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumen-release-test-'));
    try {
      const file = join(root, 'runtime.dll'); await writeFile(file,'pinned input');
      await expect(preparePayload({'runtime.dll':file},join(root,'originals'),async () => { throw new Error('timestamp refused'); })).rejects.toThrow('timestamp refused');
      expect((await readFile(join(root,'originals/runtime.dll'))).toString()).toBe('pinned input');
      expect((await readFile(file)).toString()).toBe('pinned input');
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
