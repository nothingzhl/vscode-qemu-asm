const assert = require('node:assert/strict');
const path = require('node:path');
const { runDemo, until, inView } = require('./common.cjs');

const watchState = client => client.evaluate(inView(`({
  ready: !d.getElementById('watchpoint-add').disabled && !d.body.classList.contains('stale'),
  selected: d.getElementById('tab-watchpoints').getAttribute('aria-selected'),
  hit: d.getElementById('watchpoint-hit').hidden ? '' : d.getElementById('watchpoint-hit').textContent,
  rows: [...d.querySelectorAll('#watchpoint-body tr[data-id]')].map(r => ({
    id: Number(r.dataset.id), hit: r.classList.contains('watchpoint-hit'), text: r.textContent
  }))
})`));
async function select(ctx, selector, value) {
  await ctx.inspector.evaluate(inView(`(() => {
    const e = d.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)};
    e.dispatchEvent(new Event('change', {bubbles:true})); return true;
  })()`));
}
async function watchTab(ctx) {
  await ctx.click(ctx.inspector, '#tab-watchpoints', true);
  return until(async () => { const s = await watchState(ctx.inspector); return s?.ready && s.selected === 'true' ? s : false; }, 'live data breakpoint controls');
}
async function addWatch(ctx, access) {
  await ctx.setInput(ctx.inspector, '#watchpoint-address', '0x00110000', true);
  await select(ctx, '#watchpoint-size', '4'); await select(ctx, '#watchpoint-access', access);
  await ctx.click(ctx.inspector, '#watchpoint-add', true);
  return until(async () => { const s = await watchState(ctx.inspector); return s?.ready && s.rows.length === 1 ? s : false; }, 'actual added watchpoint');
}
async function memory(ctx, changed = false) {
  await ctx.click(ctx.inspector, '#tab-memory', true);
  await until(() => ctx.inspector.evaluate(inView(`!d.getElementById('go').disabled && d.getElementById('tab-memory').getAttribute('aria-selected') === 'true'`)), 'live memory tab');
  if (!changed) {
    await ctx.setInput(ctx.inspector, '#address', '0x00110000', true);
    await ctx.click(ctx.inspector, '#go', true);
  }
  return until(() => ctx.inspector.evaluate(inView(`(() => {
    const r = d.querySelector('#memory-body tr');
    return !d.getElementById('go').disabled && r?.cells[0].textContent === '0x00110000'
      ${changed ? "&& !!r.querySelector('.byte.changed')" : ''}
      ? {text:r.textContent,changed:r.querySelectorAll('.byte.changed').length}:null;
  })()`)), changed ? 'real changed memory byte highlight' : 'actual baseline memory');
}
async function selectFrame(ctx, pc) {
  const frame = await until(() => ctx.workbench.evaluate(`(() => {
    const row = [...document.querySelectorAll('.monaco-list-row')].find(r => r.textContent.includes('当前指令') && r.textContent.toLowerCase().includes(${JSON.stringify(pc.toString(16))}));
    const r = row?.getBoundingClientRect(); return r?.width ? {x:r.left+80,y:r.top+r.height/2}:null;
  })()`), 'native frame with the actual stop address');
  await ctx.mouse(ctx.workbench, frame);
  await until(() => ctx.workbench.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.monaco-list-row')].map(r=>r.textContent.trim());
    return rows.some(r=>r.startsWith('EAX')) && rows.some(r=>r.startsWith('EIP') && r.toUpperCase().includes(${JSON.stringify(`0x${pc.toString(16).padStart(8, '0')}`.toUpperCase())}));
  })()`), 'native registers correspond to current PC', 10000);
}

runDemo({
  id: '05-data-breakpoints', title: '读取、写入与访问数据断点', host: path.join(__dirname, 'machine-host.cjs'), previewStart: 6,
  async prepare(ctx) {
    await until(async () => { await ctx.refreshTargets(); return ctx.inspector && ctx.monitor; }, 'actual inspector and monitor');
    await watchTab(ctx);
    await selectFrame(ctx, ctx.evidence.pc);
    await until(() => ctx.workbench.evaluate(`(() => {
      const rows=[...document.querySelectorAll('.monaco-list-row')].map(r=>r.textContent.trim());
      return rows.some(r=>r.startsWith('EAX')&&r.includes('0x11223344'));
    })()`), 'actual native EAX scope', 10000);
    await memory(ctx); await watchTab(ctx);
    await ctx.setInput(ctx.inspector, '#watchpoint-address', '0x00110000', true);
  },
  async driver(ctx) {
    await ctx.mark('监视真实内存 0x00110000：初始值为 0'); await ctx.hold(3);
    await ctx.mark('添加 4 字节写入断点');
    await addWatch(ctx, 'write'); await ctx.hold(2);
    let result = await ctx.rpc('continue');
    assert.equal(result.stop.reason, 'data breakpoint'); assert.equal(result.value, 1);
    assert.equal(result.watches.lastHit.access, 'write');
    await selectFrame(ctx, ctx.evidence.codeAddress + 11);
    await until(async () => (await watchState(ctx.inspector))?.rows[0]?.hit, 'actual write hit highlighted');
    await ctx.mark('写入完成后自动暂停：数据从 0 变为 1'); await ctx.hold(4);
    await memory(ctx, true); await ctx.mark('内存视图高亮实际发生变化的字节'); await ctx.hold(4);
    await watchTab(ctx); await ctx.click(ctx.inspector, '#watchpoint-clear', true);
    await until(async () => !(await watchState(ctx.inspector))?.rows.length, 'write breakpoint removed');
    await ctx.mark('切换读取断点：MOV 读取同一地址时暂停');
    await addWatch(ctx, 'read'); result = await ctx.rpc('continue');
    assert.equal(result.stop.reason, 'data breakpoint'); assert.equal(result.value, 1);
    assert.equal(result.watches.lastHit.access, 'read');
    await selectFrame(ctx, ctx.evidence.codeAddress + 13);
    await until(async () => (await watchState(ctx.inspector))?.rows[0]?.hit, 'actual read hit');
    await ctx.hold(4);
    await ctx.click(ctx.inspector, '#watchpoint-clear', true);
    await until(async () => !(await watchState(ctx.inspector))?.rows.length, 'read breakpoint removed');
    await ctx.mark('读取或写入断点：继续运行，再次捕获访问');
    await addWatch(ctx, 'readWrite'); result = await ctx.rpc('continue');
    assert.equal(result.stop.reason, 'data breakpoint'); assert.equal(result.value, 2);
    assert.equal(result.watches.lastHit.access, 'readWrite');
    await selectFrame(ctx, ctx.evidence.codeAddress + 11);
    await until(async () => (await watchState(ctx.inspector))?.rows[0]?.hit, 'actual access hit');
    await ctx.hold(4);
    await ctx.mark('访问类型、命中地址和暂停 PC 都来自真实 QEMU'); await ctx.hold(3);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
