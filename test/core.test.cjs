const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveProject, createProject, Processes, build, execute, parseErrors, qemuArguments } = require('../dist/core');
async function temporary(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm test ')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); return dir; }
test('configuration resolves selected workspace, project and spaced tool paths', () => {
 const workspace = path.resolve(os.tmpdir(), 'workspace', 'one');
 const p = resolveProject(workspace, 'my project', {source:'src/boot.asm'}, {nasm:'tools with spaces/nasm',qemuArgs:['-m','32M']});
 assert.equal(p.root,path.join(workspace,'my project')); assert.equal(p.source,path.join(workspace,'my project','src','boot.asm')); assert.equal(p.nasm,path.join(workspace,'tools with spaces','nasm'));
 const second = path.resolve(os.tmpdir(), 'workspace', 'two');
 assert.equal(resolveProject(second,'.',{}).root,second);
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
 assert.deepEqual(parseErrors('dir with spaces/boot.asm:12: error: bad\n','/work'),[{file:path.resolve('/work','dir with spaces/boot.asm'),line:11,message:'error: bad'}]);
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
test('drive relative paths fail clearly instead of using per-drive working directories', () => {
 for (const tools of [{nasm:'C:nasm.exe'},{qemu:'D:qemu.exe'}]) assert.throws(()=>resolveProject(process.cwd(),'.',{},tools),/盘符相对/);
 for (const data of [{source:'C:boot.asm'},{image:'D:boot.img'}]) assert.throws(()=>resolveProject(process.cwd(),'.',data),/盘符相对/);
 assert.throws(()=>resolveProject(process.cwd(),'C:',{}),/盘符相对/);
});
test('build preserves source reached through a directory alias', async t => {
 const root = await temporary(t); await fs.mkdir(path.join(root,'src')); const source=path.join(root,'src','boot.asm'); await fs.writeFile(source,'keep source');
 await fs.symlink(path.join(root,'src'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir');
 const p = resolveProject(root,'.',{source:'src/boot.asm',image:'alias/boot.asm'});
 const runner = new Processes(); t.after(()=>runner.dispose());
 await assert.rejects(build(p,runner,()=>{}),/同一文件/); assert.equal(await fs.readFile(source,'utf8'),'keep source');
});
test('case-insensitive file aliases cannot replace source or project configuration', async t => {
 const root = await temporary(t); await createProject(root);
 try { await fs.stat(path.join(root,'BOOT.ASM')); } catch { t.skip('Filesystem is case-sensitive; alias test runs on insensitive volumes'); return; }
 const runner = new Processes(); t.after(()=>runner.dispose());
 for (const name of ['BOOT.ASM','QEMU-ASM.JSON']) {
  const protectedFile=path.join(root,name.toLowerCase()); const before=await fs.readFile(protectedFile,'utf8');
  await assert.rejects(build(resolveProject(root,'.',{image:name}),runner,()=>{}),/同一文件/);
  assert.equal(await fs.readFile(protectedFile,'utf8'),before);
 }
});
test('split UTF-8 stdout preserves Chinese paths in diagnostics', async t => {
 const root=await temporary(t); const runner=new Processes(); t.after(()=>runner.dispose()); let output='';
 await execute(runner,process.execPath,['-e',"const bytes=Buffer.from('中文路径/boot.asm:3: error: bad'); let i=0; const timer=setInterval(()=>{process.stdout.write(bytes.subarray(i,i+1)); if(++i===bytes.length)clearInterval(timer);},1);"],root,text=>{output+=text;});
 assert.equal(parseErrors(output,root)[0].file,path.join(root,'中文路径','boot.asm'));
});
test('unexpected process termination reports failure, while plugin stop remains successful', async t => {
 const root=await temporary(t); const runner=new Processes(); t.after(()=>runner.dispose());
 const run=runner.start(process.execPath,['-e','setInterval(()=>{},1000)'],root,()=>{}); await run.ready;
 run.child.kill('SIGTERM'); await assert.rejects(run.done,/信号|退出码/);
});
