// Lifecycle unit tests with controlled screen/panel boundaries; real QEMU/UI tests run separately.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const turn=()=>new Promise(r=>setImmediate(r));
function harness() {
 let allocation; let panel; let trusted=true;let allocations=0;const logs=[];let logError;
 class Panel { constructor(_,options){this.options=options;this.frames=[];panel=this;} show(){if(this.showError)throw this.showError;} render(frame){this.frames.push(frame);} setStatus(state,message){if(this.statusError)throw this.statusError;this.state=state;this.message=message;} dispose(){this.disposed=true;} }
 class Screen extends EventEmitter {
  constructor(){super();this.args=[];this.keys=[];}
  static create(){allocations++;const pending=allocation;allocation=undefined;return pending??Promise.resolve(new Screen());}
  connect(){return Promise.resolve();} capture(){return this.captureResult??Promise.resolve({id:'frame'});} sendKey(key){this.keys.push(key);return Promise.resolve();}
  dispose(){if(!this.disposal)this.disposal=(this.gate?.promise??Promise.resolve()).then(()=>{this.disposed=true;});return this.disposal;}
 }
 const exports={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/display/controller.js'),'utf8'),{exports,require:name=>name==='./panel'?{DisplayPanel:Panel}:name==='./screen'?{QemuScreen:Screen}:require(name)});
 const controller=new exports.DisplayController({},()=>{if(!trusted)throw new Error('untrusted');},message=>{if(logError)throw logError;logs.push(message);});
 return {controller,Screen,logs,get allocations(){return allocations;},get panel(){return panel;},allocate(promise){allocation=promise;},untrust(){trusted=false;},breakLog(){logError=new Error('output disposed');}};
}
test('old screen frames and late refreshes cannot overwrite a new display session',async()=>{
 const h=harness();const old=await h.controller.create();const capture=deferred();old.captureResult=capture.promise;
 const refresh=h.panel.options.onRefresh();const current=await h.controller.create();
 current.emit('frame',{id:'new'});old.emit('frame',{id:'old'});capture.resolve({id:'late-old'});await refresh;
 assert.deepEqual(h.panel.frames.map(f=>f.id),['new']);await h.controller.dispose();
});
test('dispose waits for a screen already being stopped by another caller',async()=>{
 const h=harness();const screen=await h.controller.create();screen.gate=deferred();
 const stopping=h.controller.stop();let done=false;const disposing=h.controller.dispose().then(()=>{done=true;});await turn();assert.equal(done,false);
 screen.gate.resolve();await Promise.all([stopping,disposing]);assert(screen.disposed);assert(h.panel.disposed);
});
test('dispose waits for allocations and releases a screen created after cancellation',async()=>{
 const h=harness();const allocation=deferred();h.allocate(allocation.promise);const creating=h.controller.create();await turn();
 let done=false;const disposing=h.controller.dispose().then(()=>{done=true;});await turn();assert.equal(done,false);
 const screen=new h.Screen();allocation.resolve(screen);await assert.rejects(creating,/取消/);await disposing;assert(screen.disposed);
});
test('old stop does not release an allocation owned by a later create',async()=>{
 const h=harness();const old=await h.controller.create();old.gate=deferred();const stopping=h.controller.stop();
 const allocation=deferred();h.allocate(allocation.promise);const creating=h.controller.create();await turn();old.gate.resolve();await stopping;
 const current=new h.Screen();allocation.resolve(current);await creating;assert.equal(current.disposed,undefined);await h.controller.dispose();
});
test('display keyboard messages check trust before forwarding',async()=>{
 const h=harness();const screen=await h.controller.create();await h.panel.options.onKey('ret');assert.deepEqual(screen.keys,['ret']);h.untrust();await assert.rejects(h.panel.options.onKey('a'),/untrusted/);assert.deepEqual(screen.keys,['ret']);await h.controller.dispose();
});
test('optional display allocation failure reports a local error and returns no QMP arguments',async()=>{
 const h=harness();const pending=deferred();h.allocate(pending.promise);const creating=h.controller.createOptional();await turn();pending.reject(new Error('QMP port allocation denied'));
 const screen=await creating;assert.equal(screen,undefined);assert.equal(h.panel.state,'error');assert.match(h.panel.message,/显示资源分配失败.*QMP port allocation denied/);assert.match(h.logs.join(''),/运行和调试将继续/);
 // A dependency failure does not poison later allocation attempts.
 const recovered=await h.controller.createOptional();assert(recovered);assert.equal(h.panel.state,'connecting');await h.controller.dispose();assert(recovered.disposed);
});
test('strict display creation still rejects allocation failures',async()=>{
 const h=harness();const pending=deferred();h.allocate(pending.promise);const creating=h.controller.create();await turn();pending.reject(new Error('temporary directory unavailable'));
 await assert.rejects(creating,/显示资源分配失败.*temporary directory unavailable/);await h.controller.dispose();
});
test('disabled display allocates nothing and releases the previous owned screen',async()=>{
 const h=harness();assert.equal(await h.controller.createOptional({enabled:false}),undefined);assert.equal(h.allocations,0);assert.equal(h.panel.state,'stopped');assert.match(h.panel.message,/已关闭/);
 const old=await h.controller.create();assert.equal(h.allocations,1);assert.equal(await h.controller.createOptional({enabled:false}),undefined);assert(old.disposed);assert.equal(h.allocations,1);await h.controller.dispose();
});
test('optional display panel failure releases resources before allowing headless launch',async()=>{
 const h=harness();const screen=new h.Screen();h.allocate(Promise.resolve(screen));h.panel.showError=new Error('webview unavailable');
 assert.equal(await h.controller.createOptional(),undefined);assert(screen.disposed);assert.equal(h.panel.state,'error');assert.match(h.panel.message,/显示面板初始化失败.*webview unavailable/);await h.controller.dispose();
});
test('optional setup never turns trust failures or disposal into headless success',async()=>{
 const h=harness();h.untrust();await assert.rejects(h.controller.createOptional(),/untrusted/);await assert.rejects(h.controller.createOptional({enabled:false}),/untrusted/);assert.equal(h.allocations,0);await h.controller.dispose();
 const disposed=harness();await disposed.controller.dispose();await assert.rejects(disposed.controller.createOptional(),/已释放/);assert.equal(disposed.allocations,0);
});
test('trust revoked during allocation releases the screen and still rejects',async()=>{
 const h=harness();const pending=deferred();h.allocate(pending.promise);const creating=h.controller.createOptional();await turn();h.untrust();const screen=new h.Screen();pending.resolve(screen);await assert.rejects(creating,/untrusted/);assert(screen.disposed);await h.controller.dispose();
});
test('optional allocation cancellation is never downgraded or allowed to overwrite a later session',async()=>{
 const h=harness();const pending=deferred();h.allocate(pending.promise);const creating=h.controller.createOptional();await turn();
 const stopping=h.controller.stop();const current=await h.controller.createOptional();pending.reject(new Error('old allocation failed'));await assert.rejects(creating,/取消/);await stopping;
 assert.equal(h.panel.state,'connecting');assert.equal(current.disposed,undefined);assert.equal(h.logs.length,0);await h.controller.dispose();
});
test('persistent panel status failures cannot escape optional fallback or leak an initialized screen',async()=>{
 const h=harness();const screen=new h.Screen();h.allocate(Promise.resolve(screen));h.panel.statusError=new Error('postMessage failed synchronously');
 assert.equal(await h.controller.createOptional(),undefined);assert(screen.disposed);assert.match(h.logs.join(''),/状态上报失败.*postMessage failed synchronously/);assert.match(h.logs.join(''),/运行和调试将继续.*显示面板初始化失败/);await h.controller.dispose();assert(h.panel.disposed);
});
test('strict create still rejects panel status initialization failures and releases its screen',async()=>{
 const h=harness();const screen=new h.Screen();h.allocate(Promise.resolve(screen));h.panel.statusError=new Error('status delivery failed');
 await assert.rejects(h.controller.create(),/显示面板初始化失败.*status delivery failed/);assert(screen.disposed);await h.controller.dispose();
});
test('off and stop release owned screens even when every panel status update fails',async()=>{
 for(const action of ['off','stop']) {
  const h=harness();const screen=await h.controller.create();h.panel.statusError=new Error('webview gone');
  if(action==='off')assert.equal(await h.controller.createOptional({enabled:false}),undefined);else await h.controller.stop();
  assert(screen.disposed);assert.match(h.logs.join(''),/状态上报失败.*webview gone/);assert.equal(h.allocations,1);await h.controller.dispose();assert(h.panel.disposed);
 }
 const disabled=harness();disabled.panel.statusError=new Error('no webview');assert.equal(await disabled.controller.createOptional({enabled:false}),undefined);assert.equal(disabled.allocations,0);await disabled.controller.dispose();
});
test('broken panel status cannot bypass waiting for and releasing a cancelled allocation',async()=>{
 const h=harness();const pending=deferred();h.allocate(pending.promise);const creating=h.controller.createOptional();await turn();h.panel.statusError=new Error('webview gone');
 let stopped=false;const stopping=h.controller.stop().then(()=>{stopped=true;});await turn();assert.equal(stopped,false);const screen=new h.Screen();pending.resolve(screen);
 await assert.rejects(creating,/取消/);await stopping;assert(screen.disposed);await h.controller.dispose();
});
test('connection failure and shutdown reporting stay local when webview and output are unavailable',async()=>{
 const h=harness();const screen=await h.controller.create();h.panel.statusError=new Error('webview gone');screen.connect=()=>Promise.reject(new Error('QMP unavailable'));
 await h.controller.connect(screen);assert.match(h.logs.join(''),/QMP unavailable/);h.breakLog();assert.doesNotThrow(()=>screen.emit('status',{state:'error',message:'screendump failed'}));await h.controller.stop();assert(screen.disposed);await h.controller.dispose();
});
