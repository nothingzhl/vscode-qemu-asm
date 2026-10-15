const assert = require('node:assert/strict');
const path = require('node:path');
const { runDemo, until } = require('./common.cjs');

async function scope(ctx, pattern, expanded) {
  await until(async () => {
    const point = await ctx.workbench.evaluate(`(() => {
      const row=[...document.querySelectorAll('.monaco-list-row')].find(item=>new RegExp(${JSON.stringify(pattern)}).test(item.textContent.trim()));
      if(!row)return null;
      const twist=row.querySelector('.monaco-tl-twistie');
      if(!twist)return {done:true};
      if(twist.classList.contains('collapsed')===${JSON.stringify(!expanded)})return {done:true};
      const r=twist.getBoundingClientRect();return r.width && r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null;
    })()`);
    if(!point)return false;
    if(point.done)return true;
    await ctx.mouse(ctx.workbench,point);return false;
  }, `native variable scope ${pattern}`);
}
async function currentFrame(ctx) {
  const point=await until(()=>ctx.workbench.evaluate(`(() => {
    const row=[...document.querySelectorAll('.monaco-list-row')].find(item=>item.textContent.trim().startsWith('当前指令'));
    const r=row?.getBoundingClientRect();return r?.width&&r.height?{x:r.left+80,y:r.top+r.height/2}:null;
  })()`),'native current assembly frame');
  await ctx.mouse(ctx.workbench,point);await ctx.hold(.3);
}
async function showMode(ctx) {
  await scope(ctx,'^寄存器',false);
  await scope(ctx,'^栈内存',false);
  await scope(ctx,'^CPU 模式与地址',true);
}
function reg(state,name) {return state.registers.find(item=>item.name===name)?.value;}

runDemo({id:'02-asm-debug',title:'汇编调试：从实模式进入保护模式',host:path.join(__dirname,'asm-debug-host.cjs'),previewStart:16,
  prepare:async ctx=>{
    await currentFrame(ctx);
    await showMode(ctx);
  },
  driver:async ctx=>{
    ctx.mark('源码断点暂停在 MOV CR0：当前仍为 16 位实模式');
    await ctx.hold(3);
    ctx.mark('F11 写入 CR0.PE：观察 CPU 模式与当前源码行');
    await ctx.rpc('motion',{kind:'stepIn',expectLine:'farJump'});
    await currentFrame(ctx);
    await showMode(ctx);
    await ctx.hold(3);
    ctx.mark('再单步执行远跳转：进入 32 位保护模式');
    const protectedState=await ctx.rpc('motion',{kind:'stepIn'});
    assert.equal(parseInt(reg(protectedState,'CS'),16),8);
    await currentFrame(ctx);
    await showMode(ctx);
    await ctx.hold(3);
    ctx.mark('继续到嵌套函数断点：真实 EBP 调用栈和 QEMU 画面');
    const nested=await ctx.rpc('motion',{kind:'continue',expectLine:'nested'});
    assert(nested.stack.length>=3);
    assert.equal(parseInt(reg(nested,'EAX'),16),0x11223344);
    await currentFrame(ctx);
    await scope(ctx,'^寄存器',true);
    await ctx.hold(4);
    await ctx.capture();
    ctx.mark('SS:ESP 栈内存随暂停位置更新；F10 逐条执行');
    await ctx.rpc('motion',{kind:'next'});
    await currentFrame(ctx);
    await ctx.hold(3);
    await ctx.rpc('motion',{kind:'next'});
    await currentFrame(ctx);
    await ctx.hold(3);
    ctx.mark('Shift+F11 跳出嵌套调用：返回地址与调用栈同步变化');
    const returned=await ctx.rpc('motion',{kind:'stepOut'});
    assert(returned.stack.length<3);
    await currentFrame(ctx);
    await ctx.hold(4);
  }
}).catch(error=>{console.error(error);process.exitCode=1;});
