const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coreRequire = require('node:module').createRequire(path.join(__dirname,'../dist/project/config.js'));
// Exercise the production resolver using Node's actual platform path implementations.
// This validates path semantics; native process/filesystem behavior is tested separately in CI.
function loadWithPath(platformPath) {
 const exports={};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/project/config.js'),'utf8'),{exports,require:name=>name==='node:path'?platformPath:coreRequire(name),setTimeout,clearTimeout});
 const diagnostics={};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/project/diagnostics.js'),'utf8'),{exports:diagnostics,require:name=>name==='node:path'?platformPath:coreRequire(name)});
 return {...exports,...diagnostics,qemuArguments:require('../dist/backends/qemu/arguments').qemuArguments};
}
for (const [platform, api, workspace, absoluteTool] of [
 ['Windows',path.win32,'C:\\Users\\开发者\\Asm Workspace','D:\\Tool Box\\nasm.exe'],
 ['macOS',path.posix,'/Users/开发者/Asm Workspace','/opt/homebrew/bin/nasm'],
 ['Linux',path.posix,'/home/开发者/Asm Workspace','/opt/Tool Box/nasm'],
]) {
 test(`${platform} path semantics: relative/absolute tools, source, image and diagnostics`,()=>{
  const {resolveProject,parseErrors,qemuArguments}=loadWithPath(api);
  const p=resolveProject(workspace,'my project',{source:'src/boot.asm',image:'out/boot image.img'},{nasm:'Tool Box/nasm',qemu:absoluteTool});
  assert.equal(p.root,api.join(workspace,'my project'));
  assert.equal(p.source,api.join(p.root,'src','boot.asm')); assert.equal(p.image,api.join(p.root,'out','boot image.img'));
  assert.equal(p.nasm,api.join(workspace,'Tool Box','nasm')); assert.equal(p.qemu,absoluteTool);
  const diagnostic=parseErrors(`${p.source}:42: error: bad\r\n`,p.root)[0];
  assert.equal(diagnostic.file,p.source); assert.equal(diagnostic.line,41);
  assert(qemuArguments(p).includes(`file=${p.image},format=raw,if=floppy,readonly=on`));
  assert.equal(resolveProject(workspace,'.',{}).nasm,'nasm');
  assert.throws(()=>resolveProject(workspace,'.',{image:'../outside.img'}),/项目内/);
 });
}
test('Windows UNC shares and different drive workspace tools preserve absolute paths',()=>{
 const {resolveProject,parseErrors}=loadWithPath(path.win32);
 const workspace='\\\\server\\share\\工作目录';
 const p=resolveProject(workspace,'project',{}, {nasm:'C:\\Program Files\\NASM\\nasm.exe'});
 assert.equal(p.root,'\\\\server\\share\\工作目录\\project');
 assert.equal(p.nasm,'C:\\Program Files\\NASM\\nasm.exe');
 assert.equal(parseErrors(`${p.source}:2: error: bad`,p.root)[0].file,p.source);
 assert.throws(()=>resolveProject('C:\\work','.',{image:'D:\\escape.img'}),/项目内/);
});
