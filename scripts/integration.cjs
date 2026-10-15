const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MARKER, createProject, resolveProject, build, Processes, qemuArguments } = require('../dist/core');
(async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'qemu asm integration, '));
 const runner = new Processes();
 let timer;
 try {
  await createProject(root);
  const p = resolveProject(root,'.',JSON.parse(await fs.readFile(path.join(root,'qemu-asm.json'),'utf8')), {nasm:process.env.NASM_PATH,qemu:process.env.QEMU_PATH});
  await build(p,runner,text=>process.stdout.write(text));
  const image = await fs.readFile(p.image); assert.equal(image.length,512); assert.equal(image.subarray(510).toString('hex'),'55aa');
  console.log('PASS: NASM image = 512 bytes, signature = 55 aa');
  let output = ''; let success;
  const marker = new Promise(resolve=>{success=resolve;});
  const run = runner.start(p.qemu,qemuArguments(p),root,text=>{ output += text; process.stdout.write(text); if(output.includes(MARKER)) success(); });
  await run.ready;
  await Promise.race([marker,run.done.then(()=>{throw new Error('QEMU exited before success marker');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('QEMU serial marker timeout (15s)')),15000);})]);
  await runner.stop(); await run.done;
  assert(run.child.exitCode !== null || run.child.signalCode !== null);
  console.log('\nPASS: QEMU TCG serial marker received; process stopped');
  await fs.writeFile(p.source,'this is invalid assembly\n');
  await assert.rejects(build(p,runner,()=>{})); await assert.rejects(fs.stat(p.image));
  console.log('PASS: real NASM failure invalidates previous image');
 } finally { clearTimeout(timer); await runner.dispose(); await fs.rm(root,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
