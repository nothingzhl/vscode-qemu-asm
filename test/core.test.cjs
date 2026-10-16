const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveProject, createProject, Processes, build, execute, parseErrors, qemuArguments } = require('../dist/core');
const { localHost } = require('../dist/platform/host');
async function temporary(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asm test ')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); return dir; }
test('configuration resolves selected workspace, project and spaced tool paths', () => {
 const workspace = path.resolve(os.tmpdir(), 'workspace', 'one');
 const p = resolveProject(workspace, 'my project', {source:'src/boot.asm'}, {nasm:'tools with spaces/nasm',qemuArgs:['-m','32M']});
 assert.equal(p.root,path.join(workspace,'my project')); assert.equal(p.source,path.join(workspace,'my project','src','boot.asm')); assert.equal(p.nasm,path.join(workspace,'tools with spaces','nasm'));
 const second = path.resolve(os.tmpdir(), 'workspace', 'two');
 assert.equal(resolveProject(second,'.',{}).root,second);
 for (const data of [null,[],{image:'../outside'},{image:'boot.asm'},{image:'qemu-asm.json'}]) assert.throws(()=>resolveProject('/w','.',data));
 for (const qemuArgs of ['-m',['-daemonize'],['-drive','file=other'],['-m'],['-m','-daemonize']]) assert.throws(()=>resolveProject('/w','.',{},{qemuArgs}));
 assert(qemuArguments({...p,image:'/a,b c/boot.img'},{identity:{platform:'linux'},paths:path.posix}).includes('file=/a,,b c/boot.img,format=raw,if=floppy,readonly=on'));
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
test('stage configuration validates bounded addresses, sectors and protected output paths', () => {
 const stage={source:'stage2.asm',loadAddress:0x8000,lba:1};
 const p=resolveProject('/work','.',{stages:[stage]});
 assert.deepEqual(p.stages,[{...stage,source:path.resolve('/work','stage2.asm')}]);
 assert.deepEqual(resolveProject('/work','.',{}).stages,[]);
 for(const stages of [null,{},Array(9).fill(stage),[null],[{}],[{...stage,source:''}],[{...stage,source:'C:stage2.asm'}],[{...stage,loadAddress:0x7fff}],[{...stage,loadAddress:0xa0000}],[{...stage,loadAddress:0x8000+.5}],[{...stage,lba:0}],[{...stage,lba:18}],[{...stage,lba:1.5}]]) assert.throws(()=>resolveProject('/work','.',{stages}));
 assert.throws(()=>resolveProject('/work','.',{stages:[stage],image:'stage2.asm'}),/不能覆盖源码/);
});
test('protected project preserves an existing stage and rolls back its boot source', async t => {
 const root=await temporary(t); await fs.writeFile(path.join(root,'stage2.asm'),'my stage');
 await assert.rejects(createProject(root,'protected'));
 assert.equal(await fs.readFile(path.join(root,'stage2.asm'),'utf8'),'my stage');
 await assert.rejects(fs.stat(path.join(root,'boot.asm'))); await assert.rejects(fs.stat(path.join(root,'qemu-asm.json')));
 await fs.rm(path.join(root,'stage2.asm')); await createProject(root,'protected');
 const config=JSON.parse(await fs.readFile(path.join(root,'qemu-asm.json'),'utf8'));
 assert.deepEqual(config.stages,[{source:'stage2.asm',loadAddress:0x8000,lba:1}]);
 assert.match(await fs.readFile(path.join(root,'stage2.asm'),'utf8'),/bits 32[\s\S]*PROTECTED_MODE_OK/);
});
// A deterministic process stub supplies binary fixtures; real NASM/QEMU validation lives in stage-build-integration.cjs.
function binaryCompiler(calls=[],platform=process.platform) {
 return { host: { ...localHost, identity: { ...localHost.identity, platform } }, start(_command,args,cwd) {
  calls.push(args);
  const done=(async()=>{ await fs.copyFile(path.resolve(cwd,args[2]),path.resolve(cwd,args[args.indexOf('-o')+1])); const listing=args.indexOf('-l'); if(listing>=0)await fs.writeFile(path.resolve(cwd,args[listing+1]),'fixture listing'); })();
  return {child:{kill(){}},ready:Promise.resolve(),done};
 }};
}
async function stagedFixture(t,stageData=[Buffer.alloc(513,0x31),Buffer.from([0x32])],overrides=[],fixtureRoot) {
 const root=fixtureRoot??await temporary(t); const boot=Buffer.alloc(512); boot[510]=0x55;boot[511]=0xaa;
 await fs.writeFile(path.join(root,'boot.asm'),boot);
 const stages=[];
 for(let i=0;i<stageData.length;i++) { const source=`stage${i+1}.asm`; await fs.writeFile(path.join(root,source),stageData[i]); stages.push({source,loadAddress:0x8000+i*0x1000,lba:1+i*3,...overrides[i]}); }
 return resolveProject(root,'.',{stages});
}
test('stage build orders stages before boot, pads disk sectors and returns source units', async t => {
 const project=await stagedFixture(t); const calls=[]; const listing=path.join(project.root,'boot.lst');
 const result=await build(project,binaryCompiler(calls),()=>{},()=>false,listing);
 assert.equal(result.imageBytes,1474560); assert.deepEqual(result.units.map(unit=>unit.size),[512,513,1]);
 assert.deepEqual(result.units.map(unit=>unit.loadAddress),[0x7c00,0x8000,0x9000]);
 assert.deepEqual(result.units.map(unit=>unit.listingPath),[listing,`${listing}.stage1.lst`,`${listing}.stage2.lst`]);
 assert.deepEqual(calls.map(args=>path.resolve(project.root,args[2])),[...project.stages.map(stage=>stage.source),project.source]);
 assert.deepEqual(calls[2].slice(-2),['-D','STAGE2_SECTORS=2']);
 const image=await fs.readFile(project.image); assert.equal(image.length,1474560);
 assert.equal(image.subarray(510,512).toString('hex'),'55aa'); assert(image.subarray(512,1025).every(byte=>byte===0x31));
 assert(image.subarray(1025,2048).every(byte=>byte===0)); assert.equal(image[2048],0x32); assert(image.subarray(2049).every(byte=>byte===0));
});
test('Windows NASM keeps a Unicode project root in cwd while source/output/listing arguments stay local', async t => {
 const parent=await temporary(t), root=path.join(parent,'中文 project, with spaces'); await fs.mkdir(root);
 const project=await stagedFixture(t,undefined,undefined,root), calls=[], compiler=binaryCompiler(calls,'win32');
 const listing=path.join(root,'boot.lst'), start=compiler.start.bind(compiler);
 compiler.start=(command,args,cwd)=>{ assert.equal(cwd,root); return start(command,args,cwd); };
 const result=await build(project,compiler,()=>{},()=>false,listing);
 assert.equal(result.units.length,3); assert.equal(result.imageBytes,1474560);
 assert.deepEqual(calls.map(args=>path.resolve(root,args[2])),[...project.stages.map(stage=>stage.source),project.source]);
 for(const args of calls) {
  for(const file of [args[2],args[args.indexOf('-o')+1],args[args.indexOf('-l')+1]]) {
   assert.equal(path.isAbsolute(file),false); assert(file.startsWith(`.${path.sep}`)); assert(!file.includes('中文'));
  }
 }
 assert.equal((await fs.readFile(project.image)).subarray(510,512).toString('hex'),'55aa');
 for(const unit of result.units) assert.equal(await fs.readFile(unit.listingPath,'utf8'),'fixture listing');
});
test('stage size, disk overlap and memory overlap failures invalidate old images', async t => {
 const cases=[
  [[Buffer.alloc(0)],[],/非空/],
  [[Buffer.alloc(513)],[{lba:17}],/LBA 1\.\.17/],
  [[Buffer.alloc(512)],[{loadAddress:0x9ff00}],/常规内存/],
  [[Buffer.alloc(513),Buffer.alloc(1)],[{}, {lba:2}],/扇区范围不能重叠/],
  [[Buffer.alloc(513),Buffer.alloc(1)],[{}, {loadAddress:0x8200}],/内存范围不能重叠/]
 ];
 for(const [buffers,overrides,message]of cases) {
  const project=await stagedFixture(t,buffers,overrides); await fs.mkdir(path.dirname(project.image)); await fs.writeFile(project.image,'stale');
  await assert.rejects(build(project,binaryCompiler(),()=>{}),message); await assert.rejects(fs.stat(project.image));
  assert.deepEqual(await fs.readdir(path.dirname(project.image)),[]);
 }
});
test('stage source hardlinks and listing aliases cannot be overwritten or deleted', async t => {
 const project=await stagedFixture(t); await fs.mkdir(path.dirname(project.image));
 await fs.link(project.stages[0].source,project.image);
 await assert.rejects(build(project,binaryCompiler(),()=>{}),/同一文件/);
 assert.equal((await fs.readFile(project.stages[0].source)).length,513);
 await fs.unlink(project.image);
 await assert.rejects(build(project,binaryCompiler(),()=>{},()=>false,project.stages[0].source),/同一文件/);
 assert.equal((await fs.readFile(project.stages[0].source)).length,513);
});
