const assert = require('node:assert/strict');
const path = require('node:path');
const { runDemo, until, inView } = require('./common.cjs');

const state = client => client.evaluate(inView(`({
  ready: !d.getElementById('disassembly-go').disabled && !d.body.classList.contains('stale'),
  selected: d.getElementById('tab-disassembly').getAttribute('aria-selected'),
  rows: [...d.querySelectorAll('#disassembly-body tr')].map(r => ({
    address: Number(r.dataset.address), text: r.cells[3].textContent,
    current: r.classList.contains('current-pc'), breakpoint: r.querySelector('button').textContent
  }))
})`));

async function selectFrame(ctx, pc) {
  const current = await until(() => ctx.workbench.evaluate(`(() => {
    const row = [...document.querySelectorAll('.monaco-list-row')].find(r => r.textContent.includes('当前指令') && r.textContent.toLowerCase().includes(${JSON.stringify(pc.toString(16))}));
    const r = row?.getBoundingClientRect(); return r?.width ? {x:r.left+80,y:r.top+r.height/2}:null;
  })()`), 'current native frame matches real PC');
  await ctx.mouse(ctx.workbench, current);
  return until(() => ctx.workbench.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.monaco-list-row')].map(r=>r.textContent.trim());
    return rows.some(r=>r.startsWith('EAX') && r.includes('0x'))
      && rows.some(r=>r.startsWith('EIP') && r.toUpperCase().includes(${JSON.stringify(`0x${pc.toString(16).padStart(8, '0')}`.toUpperCase())})) ? rows : null;
  })()`), 'live native register rows', 10000);
}

runDemo({
  id: '04-disassembly', title: '反汇编、地址断点与无源码 F10', host: path.join(__dirname, 'machine-host.cjs'),
  previewStart: 9,
  async prepare(ctx) {
    await until(async () => { await ctx.refreshTargets(); return ctx.inspector && ctx.monitor; }, 'actual inspector and monitor');
    await until(async () => { const s = await state(ctx.inspector); return s?.ready && s.selected === 'true'; }, 'live disassembly');
    await selectFrame(ctx, ctx.evidence.pc);
    await ctx.hold(1);
    await ctx.setInput(ctx.inspector, '#disassembly-address', '0x00100000', true);
    await ctx.click(ctx.inspector, '#disassembly-go', true);
    await until(async () => { const s = await state(ctx.inspector); return s?.ready && s.rows[0]?.address === ctx.evidence.codeAddress; }, 'code at high address');
  },
  async driver(ctx) {
    const code = ctx.evidence.codeAddress;
    await ctx.mark('32 位保护模式：直接查看实时机器码，无需源码映射'); await ctx.hold(4);
    await ctx.mark('输入地址跳转：定位 CALL 指令');
    await ctx.setInput(ctx.inspector, '#disassembly-address', '0x00100005', true); await ctx.hold(1);
    await ctx.click(ctx.inspector, '#disassembly-go', true);
    await until(async () => { const s = await state(ctx.inspector); return s?.ready && s.rows[0]?.address === code + 5; }, 'jump to actual CALL');
    await ctx.hold(2);
    await ctx.mark('点击断点栏设置地址断点，然后继续执行');
    await ctx.click(ctx.inspector, `#disassembly-body tr[data-address="${code + 5}"] button`, true);
    await until(async () => (await state(ctx.inspector))?.rows[0]?.breakpoint === '●', 'confirmed live address breakpoint');
    await ctx.hold(2);
    let result = await ctx.rpc('continue');
    assert.equal(Number(result.frame.instructionPointerReference), code + 5);
    assert(result.stop.hitBreakpointIds.length);
    await selectFrame(ctx, code + 5);
    await ctx.mark('真实 QEMU 已命中 CALL：左侧寄存器与 PC 同步更新'); await ctx.hold(4);
    await ctx.mark('F10 执行整个 CALL / RET：EAX 从 64 变成 65');
    result = await ctx.rpc('next');
    assert.equal(Number(result.frame.instructionPointerReference), code + 10);
    assert.match(result.eax, /(?:0x0*41\b|\b65\b)/i);
    const registers = await selectFrame(ctx, code + 10);
    assert(registers.some(row => row.startsWith('EAX') && row.includes('0x00000041')));
    await until(async () => (await state(ctx.inspector))?.rows.some(r => r.current && r.address === code + 10), 'PC after actual CALL/RET');
    await ctx.hold(5);
    await ctx.mark('单步执行 INC：观察真实数据变化');
    result = await ctx.rpc('step'); assert.equal(result.value, 1);
    await selectFrame(ctx, code + 12);
    await ctx.hold(3);
    await ctx.mark('点击断点栏删除地址断点');
    await ctx.click(ctx.inspector, `#disassembly-body tr[data-address="${code + 5}"] button`, true);
    await until(async () => (await state(ctx.inspector))?.rows[0]?.breakpoint === '○', 'address breakpoint removed');
    assert.equal((await ctx.rpc('state')).instructions.breakpoints.length, 0);
    await ctx.hold(3);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
