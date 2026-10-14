import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {stageComputerUse} from './stage-computer-use';
import {stageRivetEngine} from './stage-rivet-engine';
import {stageSqliteVector} from './stage-sqlite-vector';

const version = 'v1.4.1';
const asset = 'agentgateway-windows-amd64.exe';
const expectedSha256 = '7fcdc2a51cb7ab7f5c4b5a21f9066b3704f30ec6895c386332871381fab84ab6';
const output = join(import.meta.dirname, '..', 'src-tauri', 'binaries', 'agentgateway-x86_64-pc-windows-msvc.exe');
const workerOutput = join(import.meta.dirname, '..', 'src-tauri', 'binaries', 'lumen-enrichment-x86_64-pc-windows-msvc.exe');
const rivetEngineOutput = join(import.meta.dirname, '..', 'src-tauri', 'binaries', 'lumen-rivet-engine-x86_64-pc-windows-msvc.exe');
async function digest(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main() {
  await mkdir(dirname(output), {recursive: true});
  try {
    if ((await stat(output)).isFile() && await digest(output) === expectedSha256) {
      console.log(`AgentGateway ${version} already staged and verified.`);
    } else {
      throw new Error('replace');
    }
  } catch {
    const temporary = `${output}.download`;
    await rm(temporary, {force: true});
    const response = await fetch(`https://github.com/agentgateway/agentgateway/releases/download/${version}/${asset}`);
    if (!response.ok) throw new Error(`AgentGateway download failed: HTTP ${response.status}`);
    await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
    const actualSha256 = await digest(temporary);
    if (actualSha256 !== expectedSha256) {
      await rm(temporary, {force: true});
      throw new Error(`AgentGateway checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    }
    await rename(temporary, output);
    console.log(`Staged AgentGateway ${version} (${actualSha256}).`);
  }

  const build = await Bun.build({
    entrypoints: [join(import.meta.dirname, '..', 'workers', 'enrichment-worker.ts')],
    compile: {target: 'bun-windows-x64', outfile: workerOutput},
    minify: true,
  });
  if (!build.success) {
    throw new AggregateError(build.logs, 'Could not compile the Rivet enrichment worker');
  }
  console.log('Staged the compiled Rivet enrichment worker.');
  await stageRivetEngine(rivetEngineOutput);
  // These exact old staged DLLs are no longer imported by the static runtime.
  for (const name of ['libstdc++-6.dll', 'libgcc_s_seh-1.dll', 'libwinpthread-1.dll']) {
    await rm(join(dirname(rivetEngineOutput), name), {force: true});
  }
  const noticesOutput = join(import.meta.dirname, '../src-tauri/resources/rivet-engine/THIRD-PARTY-NOTICES.txt');
  await mkdir(dirname(noticesOutput), {recursive: true});
  await copyFile(join(import.meta.dirname, '../vendor/rivet-engine/THIRD-PARTY-NOTICES.txt'), noticesOutput);
  console.log('Staged the provenance-verified static Rivet 2.3.10 engine.');
  await stageComputerUse();
  await stageSqliteVector();
  const requiredOutputs = [
    output,
    workerOutput,
    rivetEngineOutput,
    join(dirname(output), 'lumen-computer-use-x86_64-pc-windows-msvc.exe'),
    join(dirname(output), 'vector.dll'),
    noticesOutput,
  ];
  for (const required of requiredOutputs) {
    if (!(await stat(required).catch(() => undefined))?.isFile()) {
      throw new Error(`Required packaged runtime is missing: ${required}`);
    }
  }
  console.log(`Verified ${requiredOutputs.length} packaged runtime files.`);
}

await main();
