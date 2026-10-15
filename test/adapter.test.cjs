const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');
function client(options) {
 const messages=[]; const adapter=new AssemblyDebugAdapter(options); adapter.onDidSendMessage(message=>messages.push(message)); let seq=1;
 return {adapter,messages,async request(command,args={}){ const id=seq++; adapter.handleMessage({seq:id,type:'request',command,arguments:args}); const deadline=Date.now()+2000; while(Date.now()<deadline){const result=messages.find(m=>m.type==='response'&&m.request_seq===id);if(result)return result;await new Promise(r=>setTimeout(r,5));}throw new Error('response timeout');}};
}
test('debug launch rejects untrusted workspace before reading project or running tools',async()=>{
 let reads=0; const c=client({isTrusted:()=>false,getProject:async()=>{reads++;throw new Error('must not read');}});
 const response=await c.request('launch'); assert.equal(response.success,false); assert.match(response.message,/信任/);assert.equal(reads,0);
 await c.adapter.dispose(); await c.adapter.dispose(); assert.equal(c.messages.filter(m=>m.event==='terminated').length,1);
});
test('disposing during project selection cancels launch and sends no initialized event',async()=>{
 let release; const selected=new Promise(r=>{release=r;});
 const c=client({isTrusted:()=>true,getProject:async()=>{await selected;return {};}});
 const pending=c.request('launch'); await new Promise(r=>setTimeout(r,10)); await c.adapter.dispose(); release();
 const response=await pending; assert.equal(response.success,false); assert.match(response.message,/取消/);
 assert.equal(c.messages.some(m=>m.event==='initialized'),false);
});
test('debug capabilities are explicit and unpaused refreshes expose no register data',async()=>{
 const c=client({isTrusted:()=>true,getProject:async()=>{throw new Error('unused');}});
 const initialize=await c.request('initialize');assert(initialize.body.supportsReadMemoryRequest);assert.equal(initialize.body.supportsSetVariable,false);
 const response=await c.request('variables',{variablesReference:1}); assert.equal(response.success,true); assert.deepEqual(response.body.variables,[]);
 const memory=await c.request('readMemory',{memoryReference:'0x7c00',count:4}); assert.equal(memory.success,false); assert.match(memory.message,/暂停/);
 await c.adapter.dispose();
});

test('stale UI refreshes still reject an untrusted workspace',async()=>{
 const c=client({isTrusted:()=>false,getProject:async()=>{throw new Error('unused');}});
 for(const command of ['stackTrace','scopes','variables','evaluate','qemuAsm.inspectMemory','qemuAsm.inspectDescriptors']){
  const response=await c.request(command);assert.equal(response.success,false);assert.match(response.message,/信任/);
 }
 await c.adapter.dispose();
});

test('inspector requests require an actual stopped CPU before reading memory or tables',async()=>{
 const c=client({isTrusted:()=>true,getProject:async()=>{throw new Error('unused');}});
 let reads=0;
 c.adapter.runtime={registers:async()=>{reads++;throw new Error('must not read');},readMemory:async()=>{reads++;throw new Error('must not read');},dispose:async()=>{}};
 c.adapter.phase='running';
 for(const command of ['qemuAsm.inspectMemory','qemuAsm.inspectDescriptors']){
  const response=await c.request(command,{address:0x8000,table:'gdt'});
  assert.equal(response.success,false);assert.match(response.message,/暂停/);
 }
 assert.equal(reads,0);
 await c.adapter.dispose();
});
