// Lifecycle unit tests with controlled screen/panel boundaries; real QEMU/UI tests run separately.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(r=>setImmediate(r));
function harness() {
 let allocation; let panel; let trusted=true;
 class Panel { constructor(_,options){this.options=options;this.frames=[];panel=this;} show(){} render(frame){this.frames.push(frame);} setStatus(state){this.state=state;} dispose(){this.disposed=true;} }
 class Screen extends EventEmitter {
  constructor(){super();this.args=[];this.keys=[];}
  static create(){const pending=allocation;allocation=undefined;return pending??Promise.resolve(new Screen());}
  connect(){return Promise.resolve();} capture(){return this.captureResult??Promise.resolve({id:'frame'});} sendKey(key){this.keys.push(key);return Promise.resolve();}
  dispose(){if(!this.disposal)this.disposal=(this.gate?.promise??Promise.resolve()).then(()=>{this.disposed=true;});return this.disposal;}
 }
 const exports={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/display/controller.js'),'utf8'),{exports,require:name=>name==='./panel'?{DisplayPanel:Panel}:name==='./screen'?{QemuScreen:Screen}:require(name)});
 const controller=new exports.DisplayController({},()=>{if(!trusted)throw new Error('untrusted');},()=>{});
 return {controller,Screen,get panel(){return panel;},allocate(promise){allocation=promise;},untrust(){trusted=false;}};
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
