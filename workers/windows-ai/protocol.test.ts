import {expect, test} from 'bun:test';
import {resolve} from 'node:path';

const executable = process.env.LUMEN_WINDOWS_AI_TEST_EXE ?? resolve(import.meta.dir, 'bin/Debug/net10.0-windows10.0.26100.0/win-x64/lumen-windows-ai.exe');
async function requests(lines: unknown[]) {
  const child = Bun.spawn([executable], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
  child.stdin.write(lines.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
  child.stdin.end();
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(errors).toBe('');
  return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
test('malformed JSON and unknown operations return bounded errors and recover', async () => {
  const output = await requests(['{invalid', {id:'unknown', operation:'launch', payload:{}}, {id:'status', operation:'status', payload:{preferences:{}}}]);
  expect(output[0]).toMatchObject({type:'error', code:'invalid_request'});
  expect(output[1]).toMatchObject({id:'unknown', type:'error', code:'invalid_request'});
  expect(output.at(-1)).toMatchObject({id:'status', type:'result', data:{version:1}});
});
test('passive status reports the actual architecture without downloads', async () => {
  const [output] = await requests([{id:'probe',operation:'status',payload:{preferences:{windowsEnabled:true}}}]);
  expect(output).toMatchObject({type:'result',data:{host:{architecture:process.arch},accessTokenConfigured:false}});
  if (process.arch === 'x64') expect(output.data.features.find((feature: {id:string}) => feature.id === 'aion')).toMatchObject({availability:'unsupported',reasonCode:'aion_arm64_only'});
  expect(output.data.features.every((feature: {availability:string}) => feature.availability !== 'preparing')).toBe(true);
});
test('operation consent rejects preparation and private content before SDK access', async () => {
  const denied = await requests([
    {id:'prepare',operation:'prepare',payload:{featureId:'ocr',preferences:{windowsEnabled:true,ocrEnabled:true}}},
    {id:'text',operation:'text',payload:{requestId:'text',engine:'windows',task:'answer',text:'secret sentinel',preferences:{}}},
    {id:'image',operation:'image',payload:{requestId:'image',operation:'ocr',imageBase64:'AA==',preferences:{}}},
  ]);
  expect(denied.map(output => output.code)).toEqual(['consent_required','consent_required','consent_required']);
  expect(JSON.stringify(denied)).not.toContain('secret sentinel');
});
test('request byte bounds reject oversize UTF-8 and image payloads', async () => {
  const output = await requests([
    {id:'textlimit',operation:'text',payload:{requestId:'textlimit',engine:'windows',task:'answer',text:'å'.repeat(32769),preferences:{windowsEnabled:true}}},
    {id:'imagelimit',operation:'image',payload:{requestId:'imagelimit',operation:'ocr',imageBase64:Buffer.alloc(4*1024*1024+1).toString('base64'),preferences:{windowsEnabled:true,ocrEnabled:true}}},
  ]);
  expect(output.map(message => message.code)).toEqual(['input_limit','input_limit']);
});
test('cancel unknown request is an idempotent bounded result', async () => {
  const [output] = await requests([{id:'cancel-control',operation:'cancel',payload:{requestId:'not-active'}}]);
  expect(output).toMatchObject({id:'cancel-control',type:'result',data:{ok:true}});
});
test('trusted catalogue rejects caller-created content before indexing', async () => {
  const [output] = await requests([{id:'index',operation:'indexSync',payload:{version:1,items:[{id:'private',title:'User file',description:'secret sentinel',settingsPage:'privacy',keywords:[]}],preferences:{windowsEnabled:true,appContentEnabled:true}}}]);
  expect(output).toMatchObject({type:'error',code:'invalid_catalogue'});
  expect(JSON.stringify(output)).not.toContain('secret sentinel');
});
test('queued cancellation returns one terminal cancellation without model work', async () => {
  const output = await requests([
    {id:'probe-a',operation:'status',payload:{preferences:{}}},
    {id:'probe-b',operation:'status',payload:{preferences:{}}},
    {id:'cancel-target',operation:'text',payload:{requestId:'cancel-target',engine:'windows',task:'answer',text:'do not generate',preferences:{windowsEnabled:true}}},
    {id:'cancel-control',operation:'cancel',payload:{requestId:'cancel-target'}},
  ]);
  expect(output.filter(message => message.id === 'cancel-target')).toEqual([{id:'cancel-target',type:'error',code:'cancelled',message:'The operation was cancelled. A Windows-owned download may continue in Windows Update.'}]);
});
test('answer consent is independent of preview text-tool consent', async () => {
  const output = await requests([
    {id:'answer',operation:'text',payload:{requestId:'answer',engine:'aion',task:'answer',text:'test',preferences:{windowsEnabled:true,textToolsEnabled:false}}},
    {id:'write',operation:'text',payload:{requestId:'write',engine:'aion',task:'write',text:'test',preferences:{windowsEnabled:true,textToolsEnabled:false}}},
  ]);
  expect(output[0].code).not.toBe('consent_required');
  if (process.arch === 'x64') expect(output[0].code).toBe('unsupported');
  expect(output[1].code).toBe('consent_required');
});
