const assert = require('node:assert/strict');
const path = require('node:path');
const { runDemo, until, inView } = require('./common.cjs');
const tableState = client => client.evaluate(inView(`({
  ready: !d.getElementById('refresh').disabled && !d.body.classList.contains('stale'),
  title: d.getElementById('descriptor-title').textContent, meta: d.getElementById('table-meta').textContent,
  page: d.getElementById('table-page').textContent,
  rows: [...d.querySelectorAll('#descriptor-body tr')].map(r=>({text:r.textContent,cells:[...r.cells].map(c=>c.textContent)}))
})`));
async function table(ctx, tab, title) {
  await ctx.click(ctx.inspector, `#tab-${tab}`, true);
  return until(async () => { const s = await tableState(ctx.inspector); return s?.ready && s.title.includes(title) && s.rows.length ? s : null; }, `actual ${title} descriptors`);
}
async function selectCurrent(ctx, registers) {
  const pc = registers.eip;
  const frame = await until(() => ctx.workbench.evaluate(`(() => {
    const row=[...document.querySelectorAll('.monaco-list-row')].find(r=>
      r.textContent.includes('当前指令') && r.textContent.toLowerCase().includes(${JSON.stringify(pc.toString(16))}));
    const r=row?.getBoundingClientRect();return r?.width?{x:r.left+80,y:r.top+r.height/2}:null;
  })()`), 'native current CPU frame after actual mode transition');
  await ctx.mouse(ctx.workbench, frame);
  await until(() => ctx.workbench.evaluate(`(() => {
    const rows=[...document.querySelectorAll('.monaco-list-row')].map(r=>r.textContent.trim().toUpperCase());
    return ${JSON.stringify(['eip', 'esp'].map(name => ({ name: name.toUpperCase(), value: `0X${registers[name].toString(16).toUpperCase().padStart(8, '0')}` })))}
      .every(item=>rows.some(row=>row.startsWith(item.name)&&row.includes(item.value)));
  })()`), 'native EIP and ESP match independently read current CPU registers', 10000);
}
runDemo({
  id: '08-descriptors', title: 'GDT、IDT 与实模式中断向量', host: path.join(__dirname, 'inspection-host.cjs'), previewStart: 1,
  async prepare(ctx) {
    await until(async () => { await ctx.refreshTargets(); return ctx.inspector && ctx.monitor; }, 'real inspector and monitor targets');
    await table(ctx, 'gdt', 'GDT');
    await selectCurrent(ctx, ctx.evidence.registers);
  },
  async driver(ctx) {
    await ctx.mark('读取真实 GDTR 与 GDT：CS 指向代码段，SS 指向可写数据段');
    const gdt = await tableState(ctx.inspector);
    assert(gdt.rows[1].text.includes('CS')); assert(gdt.rows[2].text.includes('SS')); await ctx.hold(6);
    await ctx.mark('每项显示段基址、有效界限、DPL、位宽与访问权限');
    assert(gdt.rows[1].text.includes('32')); assert(gdt.rows[1].text.includes('0xFFFFFFFF')); await ctx.hold(4);
    await ctx.mark('切换 IDT：向量 3 的 32 位中断门指向代码选择子 0x0008');
    const idt = await table(ctx, 'idt', 'IDT');
    assert(idt.rows[3].cells.includes('0x0008')); assert(idt.rows[3].cells.includes('32')); await ctx.hold(6);
    await ctx.mark('重启回实模式：同一面板自动改为 BIOS 中断向量表 IVT');
    const restarted = await ctx.rpc('restart');
    await selectCurrent(ctx, restarted.registers);
    await table(ctx, 'idt', 'IVT'); await ctx.hold(5);
    await ctx.mark('向量表支持分页浏览：继续查看后续中断入口');
    await ctx.click(ctx.inspector, '#descriptor-next', true);
    await until(async () => { const s = await tableState(ctx.inspector); return s?.ready && !s.page.startsWith('0–'); }, 'next real IVT page');
    await ctx.hold(4);
    await ctx.mark('继续进入保护模式：GDT 与段寄存器缓存信息恢复同步');
    const result = await ctx.rpc('continue'); assert.equal(result.registers.cs, 8);
    await selectCurrent(ctx, result.registers);
    await table(ctx, 'gdt', 'GDT'); await ctx.hold(4);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
