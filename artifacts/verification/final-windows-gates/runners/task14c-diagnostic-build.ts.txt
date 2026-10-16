import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='.superpowers/sdd/2026-10-12-production-readiness/task14c-evidence';
const glue='node_modules/@rivetkit/rivetkit-wasm/pkg/rivetkit_wasm.js';
const sdk='node_modules/rivetkit/dist/tsup/mod.js';
const original=new Map([glue,sdk].map(path=>[path,readFileSync(path)]));
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
for(const [path,bytes] of original) writeFileSync(`${root}/diagnostic-original-${path===glue?'glue':'sdk'}.js`,bytes);
try{
 let text=original.get(glue)!.toString();
 const needle='const ret = new Uint8Array(arg0);';
 if(text.split(needle).length!==2) throw new Error('unexpected glue');
 text=text.replace(needle,`let ret; try { ret = new Uint8Array(arg0); } catch (error) { console.error('OWNED_BUFFER_DIAGNOSTIC', JSON.stringify({kind:Object.prototype.toString.call(arg0),length:arg0?.length,byteLength:arg0?.byteLength,detached:arg0?.buffer?.detached,bufferDetached:arg0?.detached,currentWasmBuffer:arg0===wasm.memory.buffer||arg0?.buffer===wasm.memory.buffer,cachedWasmBuffer:arg0===cachedUint8ArrayMemory0?.buffer||arg0?.buffer===cachedUint8ArrayMemory0?.buffer,callback:globalThis.__ownedBufferCallbacks?.get(arg0),stack:error.stack})); throw error; }`);
 writeFileSync(glue,text);
 text=original.get(sdk)!.toString();
 const factory='new this.#bindings.ActorFactory(callbacks, config)';
 if(text.split(factory).length!==2) throw new Error('unexpected factory');
 text=text.replace(factory,`new this.#bindings.ActorFactory((() => { const map=globalThis.__ownedBufferCallbacks??=new WeakMap(); const wrap=(value,path)=>Object.fromEntries(Object.entries(value).map(([name,callback])=>[name,typeof callback==='function'?function(...args){return Promise.resolve(callback(...args)).then(result=>{if(result&&typeof result==='object'){map.set(result,{callback:path+name,length:result.byteLength,at:Date.now()});if(result.body&&typeof result.body==='object')map.set(result.body,{callback:path+name+'.body',length:result.body.byteLength,at:Date.now()});} return result;});}:callback&&typeof callback==='object'?wrap(callback,path+name+'.'):callback])); return wrap(callbacks,''); })(), config)`);
 writeFileSync(sdk,text);
 const result=await Bun.build({entrypoints:['workers/enrichment-worker.ts'],compile:{target:'bun-windows-x64',outfile:'.superpowers/task14c-diagnostic-worker.exe'},minify:true});
 if(!result.success)throw new AggregateError(result.logs);
 const test=readFileSync('workers/enrichment-runtime.test.ts','utf8');
 const worker="const worker = join(binaries, 'lumen-enrichment-x86_64-pc-windows-msvc.exe');";
 if(test.split(worker).length!==2)throw new Error('unexpected fixture');
 writeFileSync('.superpowers/task14c-diagnostic-runtime.test.ts',test.replace(worker,"const worker = resolve('.superpowers/task14c-diagnostic-worker.exe');"));
}finally{
 for(const [path,bytes]of original){writeFileSync(path,bytes);if(hash(readFileSync(path))!==hash(bytes))throw new Error('dependency restore mismatch');}
 writeFileSync(`${root}/diagnostic-dependency-restore.json`,JSON.stringify({at:new Date().toISOString(),files:[...original].map(([path,bytes])=>({path,sha256:hash(bytes),restoredSha256:hash(readFileSync(path))}))},null,2));
}
console.log('Built separate diagnostic worker; original dependency bytes restored and verified.');
