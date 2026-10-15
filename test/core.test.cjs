const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveProject, createProject, Processes, build, execute, parseErrors, qemuArguments } = require('../dist/core');
async function temporary(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm test ')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); return dir; }
test('configuration resolves selected workspace, project and spaced tool paths', () => {
 const p = resolveProject('/workspace/one', 'my project', {source:'src/boot.asm'}, {nasm:'tools with spaces/nasm',qemuArgs:['-m','32M']});
 assert.equal(p.root,'/workspace/one/my project'); assert.equal(p.source,'/workspace/one/my project/src/boot.asm'); assert.equal(p.nasm,'/workspace/one/tools with spaces/nasm');
 assert.equal(resolveProject('/workspace/two','.',{}).root,'/workspace/two');
 for (const data of [null,[],{image:'../outside'},{image:'boot.asm'},{image:'qemu-asm.json'}]) assert.throws(()=>resolveProject('/w','.',data));
 for (const qemuArgs of ['-m',['-daemonize'],['-drive','file=other'],['-m'],['-m','-daemonize']]) assert.throws(()=>resolveProject('/w','.',{},{qemuArgs}));
 assert(qemuArguments({...p,image:'/a,b c/boot.img'}).includes('file=/a,,b c/boot.img,format=raw,if=floppy,readonly=on'));
});
test('project creation preserves existing files and rolls back only newly created files', async t => {
 const root = await temporary(t); await fs.writeFile(path.join(root,'qemu-asm.json'),'keep');
 await assert.rejects(createProject(root)); assert.equal(await fs.readFile(path.join(root,'qemu-asm.json'),'utf8'),'keep');
 await assert.rejects(fs.stat(path.join(root,'boot.asm')));
 await fs.rm(path.join(root,'qemu-asm.json')); await createProject(root); await assert.rejects(createProject(root));
 assert.match(await fs.readFile(path.join(root,'boot.asm'),'utf8'),/QEMU_ASM_BOOT_OK/);
});
test('failed build removes stale image and temporary output', async t => {
 const root = await temporary(t); const p = resolveProject(root,'.',{}, {nasm:process.execPath});
 await fs.mkdir(path.dirname(p.image)); await fs.writeFile(p.image,'old image');
 const runner = new Processes(); t.after(()=>runner.dispose());
 await assert.rejects(build(p,runner,()=>{})); await assert.rejects(fs.stat(p.image)); assert.deepEqual(await fs.readdir(path.dirname(p.image)),[]);
});
test('missing tool and immediate nonzero exit fail; manager remains usable', async t => {
 const root = await temporary(t); const runner = new Processes(); t.after(()=>runner.dispose());
 await assert.rejects(execute(runner,path.join(root,'missing'),[],root,()=>{}));
 await assert.rejects(execute(runner,process.execPath,['-e','process.exit(7)'],root,()=>{}),/退出码 7/);
 await execute(runner,process.execPath,['-e','process.exit(0)'],root,()=>{});
});
test('stop terminates owned child, is repeatable and dispose blocks future launches', async t => {
 const root = await temporary(t); const runner = new Processes(); t.after(()=>runner.dispose());
 const child = runner.start(process.execPath,['-e','setInterval(()=>{},1000)'],root,()=>{}); await child.ready;
 await runner.stop(); await child.done; assert(child.child.exitCode !== null || child.child.signalCode !== null);
 await runner.stop(); await runner.dispose(); assert.throws(()=>runner.start(process.execPath,[],root,()=>{}));
});
test('timeouts reject rather than treating forced termination as success', async t => {
 const root = await temporary(t); const runner = new Processes(); t.after(()=>runner.dispose());
 await assert.rejects(execute(runner,process.execPath,['-e','setInterval(()=>{},1000)'],root,()=>{},100),/超时/);
});
test('NASM diagnostics parse paths containing spaces and Windows drive colon', () => {
 assert.deepEqual(parseErrors('dir with spaces/boot.asm:12: error: bad\n','/work'),[{file:'/work/dir with spaces/boot.asm',line:11,message:'error: bad'}]);
 assert.equal(parseErrors('C:\\src\\boot.asm:3: error: bad','/work')[0].line,2);
});
test('cancelled build cannot launch a tool or produce an image', async t => {
 const root = await temporary(t); const runner = new Processes(); t.after(()=>runner.dispose());
 const p = resolveProject(root,'.',{}, {nasm:path.join(root,'must not launch')});
 await assert.rejects(build(p,runner,()=>{},()=>true),/已停止/); await assert.rejects(fs.stat(p.image));
});
test('image parent symlink cannot redirect writes outside project', { skip: process.platform === 'win32' }, async t => {
 const root = await temporary(t); const outside = await temporary(t);
 await fs.symlink(outside,path.join(root,'build')); await fs.writeFile(path.join(outside,'boot.img'),'keep');
 const runner = new Processes(); t.after(()=>runner.dispose());
 await assert.rejects(build(resolveProject(root,'.',{}),runner,()=>{}),/符号链接/);
 assert.equal(await fs.readFile(path.join(outside,'boot.img'),'utf8'),'keep');
});
test('stop escalates when an owned process ignores SIGTERM', { skip: process.platform === 'win32' }, async t => {
 const root = await temporary(t); const runner = new Processes(); t.after(()=>runner.dispose());
 let ready; const initialized = new Promise(resolve=>{ready=resolve;});
 const run = runner.start(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],root,()=>ready());
 await run.ready; await initialized; await runner.stop(); await run.done;
 assert.equal(run.child.signalCode,'SIGKILL');
});
