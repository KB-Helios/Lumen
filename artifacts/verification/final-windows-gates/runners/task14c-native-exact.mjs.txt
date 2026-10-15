import {spawnSync} from 'node:child_process';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='.superpowers/sdd/2026-10-12-production-readiness/task14c-evidence';
const receipt=JSON.parse(readFileSync(`${root}/rust-tests-full.json`,'utf8'));
if(receipt.code!==0)throw new Error('full native compilation/test receipt must succeed first');
const stderr=readFileSync(`${root}/rust-tests-full.stderr.log`,'utf8');
const matches=[...new Set([...stderr.matchAll(/\((D:[^\r\n]*?lumen_lib-[a-f0-9]+\.exe)\)/g)].map(match=>match[1].replaceAll('\\','/')))];
if(matches.length!==1)throw new Error('actual native test binary is ambiguous');
const binary=matches[0];
if(statSync(binary).mtimeMs<Date.parse(receipt.started))throw new Error('binary predates current compile');
const metadata={at:new Date().toISOString(),binary,bytes:statSync(binary).size,sha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),source:receipt.head,patchSha256:receipt.patchSha256};
const tests={
 digest:'gateway::supervisor::tests::pinned_gateway_digest_matches_compiled_admission',
 config:'gateway::config::tests::pinned_binary_accepts_generated_config',
 credential:'provider_switcher::profiles::tests::windows_credentials_owned_slot_round_trip',
 wire:'computer_use::executor::tests::rust_executor_wire_and_warm_pool_verify_real_edge_state',
 stop:'computer_use::coordinator::tests::native_stop_twenty_blocked_worker_samples',
 proxy:'local_http_tests::local_http_proxy_bypass_in_isolated_process',
};
const gate=process.argv[2];
const args=gate==='inventory'?['--ignored','--list']:['--exact',tests[gate],...(gate==='proxy'?[]:['--ignored']),'--test-threads=1','--nocapture'];
if(gate!=='inventory'&&!tests[gate])throw new Error('unknown exact gate');
writeFileSync(`${root}/native-${gate}-binary.json`,JSON.stringify({...metadata,args},null,2));
const result=spawnSync(binary,args,{encoding:'utf8',windowsHide:true,maxBuffer:10*1024*1024,env:process.env});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
if(gate==='inventory'){
 const paths=result.stdout.split('\n').filter(line=>line.endsWith(': test')).map(line=>line.slice(0,-6));
 if(paths.length!==26)throw new Error(`Expected26 exact ignored entries, got${paths.length}`);
 writeFileSync(`${root}/ignored-final-paths.json`,JSON.stringify({...metadata,paths},null,2));
}else if(!/test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(result.stdout))throw new Error('required exact test did not execute once successfully');
