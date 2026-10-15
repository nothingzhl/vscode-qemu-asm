const assert = require('node:assert/strict');
const path = require('node:path');
const { runDemo, until } = require('./common.cjs');

async function selectFrame(ctx, name) {
  const point = await until(() => ctx.workbench.evaluate(`(() => {
    const row = [...document.querySelectorAll('.monaco-list-row')].find(item => item.textContent.trim().startsWith(${JSON.stringify(name)}));
    const r = row?.getBoundingClientRect(); return r && r.width && r.height ? { x:r.left+Math.min(90,r.width/2), y:r.top+r.height/2 } : null;
  })()`), `native ${name} call-stack frame`);
  await ctx.mouse(ctx.workbench, point);
  await ctx.hold(.5);
}
async function expand(ctx, name) {
  await until(async () => {
    const point = await ctx.workbench.evaluate(`(() => {
      const row=[...document.querySelectorAll('.monaco-list-row')].find(item => item.querySelector('.expression .name')?.textContent.trim().replace(' =','')===${JSON.stringify(name)} || item.querySelector('.name')?.textContent.trim().replace(' =','')===${JSON.stringify(name)});
      if(!row) return null;
      const twist=row.querySelector('.monaco-tl-twistie');
      if(!twist?.classList.contains('collapsed')) return {expanded:true};
      const r=twist.getBoundingClientRect();return r.width && r.height ? {x:r.left+r.width/2,y:r.top+r.height/2}:null;
    })()`);
    if(!point)return false;
    if(point.expanded)return true;
    await ctx.mouse(ctx.workbench, point);
    return false;
  }, `expand native C variable ${name}`);
}
async function expandParameters(ctx) {
  await until(async()=>{
    const point=await ctx.workbench.evaluate(`(() => {
      const row=[...document.querySelectorAll('.monaco-list-row')].find(item=>/^(参数|Arguments)/.test(item.textContent.trim()));
      if(!row)return null;
      const twist=row.querySelector('.monaco-tl-twistie');
      if(!twist?.classList.contains('collapsed'))return {done:true};
      const r=twist.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null;
    })()`);
    if(!point)return false;if(point.done)return true;await ctx.mouse(ctx.workbench,point);return false;
  },'native C parameter scope');
}

runDemo({ id:'03-c-source', title:'C 源码调试：断点、调用栈与变量', host:path.join(__dirname,'c-source-host.cjs'), previewStart:10,
  prepare:async ctx => {
    await selectFrame(ctx,'kernel_main');
    await expand(ctx,'sample');
    await expand(ctx,'values');
  },
  driver:async ctx => {
    ctx.mark('C 源码行断点：保护态与分页中的 kernel_main');
    await ctx.hold(3);
    ctx.mark('F11 进入函数：真实 DWARF 参数与源码位置');
    await ctx.rpc('motion',{kind:'stepIn',expectName:'compute'});
    await selectFrame(ctx,'compute');
    await expandParameters(ctx);
    await ctx.hold(3);
    ctx.mark('继续到嵌套断点：局部变量 delta = 5、total = 42');
    await ctx.rpc('motion',{kind:'continue',expectName:'compute',expectLine:'NESTED_READY'});
    await selectFrame(ctx,'compute');
    await expand(ctx,'snapshot');
    await until(() => ctx.workbench.evaluate(`(() => {const rows=[...document.querySelectorAll('.monaco-list-row')].map(item=>item.textContent.trim());return rows.some(row=>/^total/.test(row)&&row.includes('42')) && rows.some(row=>/^delta/.test(row)&&row.includes('5'));})()`), 'actual native C local values');
    await ctx.hold(4);
    await ctx.capture();
    ctx.mark('选择调用者：查看指针，展开结构体与数组');
    await selectFrame(ctx,'kernel_main');
    await expand(ctx,'sample');
    await expand(ctx,'values');
    await ctx.hold(4);
    ctx.mark('Shift+F11 返回调用者：调用栈与源码同步变化');
    await ctx.rpc('removeNestedBreakpoint');
    let moved = await ctx.rpc('motion',{kind:'stepOut',expectName:'kernel_main'});
    await selectFrame(ctx,'kernel_main');
    await ctx.hold(3);
    if(moved.stack[0].line===ctx.evidence.lines.call) moved=await ctx.rpc('motion',{kind:'next',expectName:'kernel_main'});
    ctx.mark('F10 执行赋值：global_result 变为 42');
    await ctx.rpc('motion',{kind:'next',expectName:'kernel_main'});
    await selectFrame(ctx,'kernel_main');
    const state=await ctx.rpc('state');
    assert.match(String(state.result),/\b42\b/);
    assert.deepEqual(state.failures,[], 'native C debugging must not emit failed DAP responses');
    await ctx.hold(4);
  }
}).catch(error=>{console.error(error);process.exitCode=1;});
