const assert = require('node:assert/strict');
const path = require('node:path');
const { runDemo, until, inView } = require('./common.cjs');
const hex = value => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
const state = client => client.evaluate(inView(`({
  ready: !d.getElementById('go').disabled && !d.body.classList.contains('stale'),
  range: d.getElementById('memory-range').textContent,
  follow: d.getElementById('follow').value,
  text: d.getElementById('memory-body').textContent,
  changed: d.querySelectorAll('#memory-body td.changed').length,
  bytes: [...d.querySelectorAll('#memory-body tr:first-child td.byte')].map(cell => cell.textContent)
})`));
async function address(ctx, value) {
  await ctx.setInput(ctx.inspector, '#address', hex(value), true);
  await ctx.click(ctx.inspector, '#go', true);
  return until(async () => { const s = await state(ctx.inspector); return s?.ready && s.range.startsWith(hex(value)) ? s : null; }, 'real memory address');
}
runDemo({
  id: '06-memory', title: '内存、变化高亮与栈跟随', host: path.join(__dirname, 'inspection-host.cjs'), previewStart: 8,
  async prepare(ctx) {
    await until(async () => { await ctx.refreshTargets(); return ctx.inspector && ctx.monitor; }, 'real inspector and monitor targets');
    await ctx.click(ctx.inspector, '#tab-memory', true);
    await address(ctx, ctx.evidence.dataAddress);
    const frame = await until(() => ctx.workbench.evaluate(`(() => {
      const row = [...document.querySelectorAll('.monaco-list-row')].find(r => r.textContent.includes('当前指令'));
      const r = row?.getBoundingClientRect(); return r?.width ? {x:r.left+80,y:r.top+r.height/2}:null;
    })()`), 'native selected CPU frame');
    await ctx.mouse(ctx.workbench, frame);
  },
  async driver(ctx) {
    await ctx.mark('内存由暂停的真实 QEMU 读取：十六进制与 ASCII 同时显示'); await ctx.hold(4);
    await ctx.mark('单步越过 NOP，定位将要写入内存的 INC');
    await ctx.rpc('step'); await ctx.hold(2);
    await ctx.mark('执行 INC：第三个双字从 0 变成 1，变化字节自动高亮');
    const changed = await ctx.rpc('step', { expectChanged: true });
    assert.equal(changed.memory.bytes[8], 1);
    await until(async () => { const s = await state(ctx.inspector); return s?.ready && s.changed === 1 && s.bytes[8] === '01'; }, 'actual single-byte memory difference');
    await ctx.hold(5);
    await ctx.mark('输入另一处真实地址：ASCII 栏识别内核成功字符串');
    const marker = await ctx.rpc('memory', { address: 0x8300, count: 32 });
    assert(Buffer.from(marker.bytes).toString('ascii').includes('PROTECTED_MODE_OK'));
    await address(ctx, 0x8300);
    await until(async () => (await state(ctx.inspector))?.text.includes('PROTECTED_MODE_O'), 'actual guest ASCII string');
    await ctx.hold(4);
    await ctx.mark('切换到 SS:ESP：自动跟随当前栈，查看返回地址和栈数据');
    await ctx.setInput(ctx.inspector, '#follow', 'esp', true);
    await until(async () => { const s = await state(ctx.inspector); return s?.ready && s.follow === 'esp' && s.range.startsWith(hex(ctx.evidence.registers.esp)); }, 'live SS:ESP stack memory');
    await ctx.hold(5);
    await ctx.mark('也可跟随 SS:EBP：把栈内存与左侧调用栈、寄存器对应起来');
    await ctx.setInput(ctx.inspector, '#follow', 'ebp', true);
    await until(async () => { const s = await state(ctx.inspector); return s?.ready && s.follow === 'ebp'; }, 'live SS:EBP stack memory');
    await ctx.hold(4);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
