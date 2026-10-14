import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {gunzipSync} from 'node:zlib';

export const rivetEngineSha256 = '6ec17d878a0800962e5c88ca05e6e58665b2ba693fa86dac3077ee5d9d89d089';
const compressedSha256 = 'ac0d722cf92d365c1ad8256154c1fb11f45d96935057f0236d4c788f84399995';
const vendor = join(import.meta.dirname, '../vendor/rivet-engine');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function stageRivetEngine(output: string, source = join(vendor, 'rivet-engine-2.3.10.exe.gz')) {
  const compressed = await readFile(source);
  if (compressed.length !== 31460683 || digest(compressed) !== compressedSha256) throw new Error('Rivet compressed input checksum mismatch');
  const executable = gunzipSync(compressed, {maxOutputLength: 86179438});
  if (executable.length !== 86179438 || digest(executable) !== rivetEngineSha256) throw new Error('Rivet executable checksum mismatch');
  await mkdir(dirname(output), {recursive: true});
  if ((await stat(output).catch(() => undefined))?.isFile() && digest(await readFile(output)) === rivetEngineSha256) return;
  const temporary = `${output}.verified`;
  try {await writeFile(temporary, executable); await rename(temporary, output);} finally {await rm(temporary, {force: true});}
}

if (import.meta.main) await stageRivetEngine(join(import.meta.dirname, '../src-tauri/binaries/lumen-rivet-engine-x86_64-pc-windows-msvc.exe'));
