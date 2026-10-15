const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MachineBreakpoints, machineAddress, watchpoint, memoryDataId } = require('../dist/debug/machineBreakpoints');

test('native and custom instruction breakpoint lists retain independent ownership and stable IDs', async () => {
  const points = new MachineBreakpoints(); let installed;
  const apply = async addresses => { installed = [...addresses]; };
  const native = await points.setNativeInstructions([{instructionReference:'0x100000'}],apply);
  await points.changeInstruction({action:'add',address:0x100000},apply);
  assert.equal(points.instructions().breakpoints[0].origin,'both');
  assert.equal(points.instructions().breakpoints[0].id,native[0].id);
  await points.setNativeInstructions([],apply);
  assert.deepEqual(installed,[0x100000]);
  assert.equal(points.instructions().breakpoints[0].origin,'custom');
  await points.setNativeInstructions([{instructionReference:'0x100000'}],apply);
  await points.changeInstruction({action:'clear'},apply);
  assert.deepEqual(installed,[0x100000]);
  assert.equal(points.instructions().breakpoints[0].origin,'native');
  assert.deepEqual(points.instructionHit(0x100000),[native[0].id]);
});

test('native and custom data breakpoints preserve ownership; QEMU hit IDs match reported start and kind', async () => {
  const points = new MachineBreakpoints(); let installed;
  const apply = async list => { installed = structuredClone(list); };
  const spec = {address:0x1001,size:1,access:'write'};
  const native = await points.setNativeWatches([{dataId:memoryDataId(spec.address,spec.size),accessType:'write'}],apply);
  await points.changeWatch({action:'add',...spec},apply);
  assert.equal(points.watches().breakpoints[0].origin,'both');
  await points.setNativeWatches([],apply);
  assert.deepEqual(installed,[spec]);
  assert.equal(points.watches().breakpoints[0].id,native[0].id);
  await points.changeWatch({action:'add',address:0x1000,size:4,access:'write'},apply);
  await points.changeWatch({action:'add',address:0x1001,size:2,access:'write'},apply);
  await points.changeWatch({action:'add',address:0x1001,size:1,access:'readWrite'},apply);
  const candidates = points.watches().breakpoints.filter(p=>p.address===0x1001&&p.access==='write').map(p=>p.id);
  assert.deepEqual(points.dataHits(0x1001,'write'),candidates);
  assert.equal(candidates.length,2,'same-start size ambiguity is retained without blaming neighboring ranges');
  assert.deepEqual(points.dataHits(0x1002,'write'),[]);
  await points.changeWatch({action:'remove',id:native[0].id},apply);
  assert(!points.watches().breakpoints.some(p=>p.id===native[0].id));
});

test('failed runtime installation does not commit either ownership list', async () => {
  const points = new MachineBreakpoints(); const apply = async()=>{};
  await points.changeInstruction({action:'add',address:0x1234},apply);
  await points.changeWatch({action:'add',address:0x2001,size:2,access:'read'},apply);
  const failed = async()=>{throw new Error('runtime rollback preserved previous set');};
  await assert.rejects(points.setNativeInstructions([{instructionReference:'0x1235'}],failed),/rollback/);
  await assert.rejects(points.changeInstruction({action:'clear'},failed),/rollback/);
  await assert.rejects(points.setNativeWatches([],failed),/rollback/);
  await assert.rejects(points.changeWatch({action:'clear'},failed),/rollback/);
  assert.deepEqual(points.instructionAddresses(),[0x1234]);
  assert.deepEqual(points.dataPoints(),[{address:0x2001,size:2,access:'read'}]);
});

test('invalid breakpoint rows are unverified and union limits and address overflow are enforced', async () => {
  for(const value of [-1,0x100000000,NaN,1.5,'eax','0x100000000',{},null]) assert.throws(()=>machineAddress(value));
  assert.equal(machineAddress('0xFFFFFFFF'),0xffffffff);
  assert.deepEqual(watchpoint({address:3,size:4,access:'read'}),{address:3,size:4,access:'read'});
  assert.throws(()=>watchpoint({address:0xffffffff,size:2,access:'write'}));
  const points = new MachineBreakpoints(); const apply = async()=>{};
  const bad = await points.setNativeInstructions([{instructionReference:'0xFFFFFFFF',offset:1},{instructionReference:'0x1234',condition:'x'}],apply);
  assert(bad.every(row=>!row.verified));
  await points.changeInstruction({action:'add',address:0x10000},apply);
  await assert.rejects(points.setNativeInstructions(Array.from({length:256},(_,i)=>({instructionReference:String(i)})),apply),/256/);
  for(let index=0;index<16;index++) await points.changeWatch({action:'add',address:index,size:1,access:'write'},apply);
  await assert.rejects(points.setNativeWatches([{dataId:memoryDataId(100,1),accessType:'write'}],apply),/16/);
});
