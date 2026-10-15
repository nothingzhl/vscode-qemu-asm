const assert = require('node:assert/strict');
const path = require('node:path');
const { runDemo, until, inView } = require('./common.cjs');
const hex = value => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
const pageState = client => client.evaluate(inView(`({
  ready: !d.getElementById('paging-go').disabled && !d.body.classList.contains('stale'),
  path: d.getElementById('paging-path').textContent, result: d.getElementById('paging-result').textContent,
  permissions: d.getElementById('paging-permissions').textContent,
  rows: d.querySelectorAll('#paging-body tr').length
})`));
async function page(ctx, value) {
  await ctx.inspector.evaluate(inView(`(() => {
    d.getElementById('tab-paging').click();
    d.getElementById('paging-address').value=${JSON.stringify(hex(value))};
    d.getElementById('paging-form').requestSubmit();return true;
  })()`));
  return until(async () => { const s = await pageState(ctx.inspector); return s?.ready && s.path.includes(hex(value)) ? s : null; }, 'actual virtual-to-physical walk');
}
async function memory(ctx, address, space) {
  await ctx.click(ctx.inspector, '#tab-memory', true);
  // Submit the actual controls in one UI task so the asynchronous old-address
  // read caused by the selector cannot disable the submit button in between.
  await ctx.inspector.evaluate(inView(`(() => {
    const selector=d.getElementById('memory-space');selector.value=${JSON.stringify(space)};
    selector.dispatchEvent(new Event('change',{bubbles:true}));
    d.getElementById('address').value=${JSON.stringify(hex(address))};
    d.getElementById('address-form').requestSubmit();return true;
  })()`));
  return until(() => ctx.inspector.evaluate(inView(`(() => {
    if (d.getElementById('go').disabled || d.body.classList.contains('stale')) return null;
    if (d.getElementById('memory-space').value !== ${JSON.stringify(space)} || !d.getElementById('memory-range').textContent.startsWith(${JSON.stringify(hex(address))})) return null;
    return {context:d.getElementById('memory-context').textContent, bytes:[...d.querySelectorAll('#memory-body tr:first-child td.byte')].map(c=>c.textContent)};
  })()`)), `actual ${space} memory`);
}
runDemo({
  id: '07-paging', title: '分页、地址转换与物理内存', host: path.join(__dirname, 'paging-host.cjs'), previewStart: 2,
  async prepare(ctx) {
    await until(async () => { await ctx.refreshTargets(); return ctx.inspector && ctx.monitor; }, 'real inspector and monitor targets');
    await page(ctx, ctx.evidence.linearAddress);
    const frame = await until(() => ctx.workbench.evaluate(`(() => {
      const row = [...document.querySelectorAll('.monaco-list-row')].find(r => r.textContent.includes('当前指令'));
      const r = row?.getBoundingClientRect(); return r?.width ? {x:r.left+80,y:r.top+r.height/2}:null;
    })()`), 'native current paged instruction frame');
    await ctx.mouse(ctx.workbench, frame);
  },
  async driver(ctx) {
    await ctx.mark('分页已开启：CR3 → 页目录项 → 页表项 → 物理地址'); await ctx.hold(4);
    let current = await pageState(ctx.inspector);
    assert(current.path.includes(hex(ctx.evidence.physicalAddress))); assert.equal(current.rows, 2);
    await ctx.mark('同一套页表也解释代码页权限：此映射只允许管理态访问');
    const code = await page(ctx, ctx.evidence.codeAddress);
    assert(code.path.includes(hex(ctx.evidence.codePhysicalAddress))); await ctx.hold(3);
    await ctx.mark('只读页面：CR0.WP 开启时，管理态写入同样被禁止');
    const readonly = await page(ctx, ctx.evidence.readonlyAddress);
    assert(readonly.permissions.includes('管理态写入 禁止')); await ctx.hold(3);
    await ctx.mark('缺页会明确指出 P=0，不会伪造物理地址');
    const missing = await page(ctx, ctx.evidence.unmappedAddress);
    assert(missing.result.includes('P=0')); await ctx.hold(3);
    await ctx.mark('PSE 4 MiB 大页：由页目录直接完成转换');
    const large = await page(ctx, ctx.evidence.bigAddress);
    assert(large.result.includes('4 MiB')); assert.equal(large.rows, 1); await ctx.hold(4);
    await ctx.mark('虚拟地址 0xC0100000：查看内核刚刚写入的真实数据');
    const virtual = await memory(ctx, ctx.evidence.linearAddress, 'virtual'); assert.equal(virtual.bytes[0], '01'); await ctx.hold(4);
    await ctx.mark('切换物理地址 0x00210000：两个地址访问的是同一块 RAM');
    const physical = await memory(ctx, ctx.evidence.physicalAddress, 'physical'); assert.deepEqual(physical.bytes, virtual.bytes); await ctx.hold(4);
    await ctx.mark('回到页表视图：映射关系、页标志与权限保持可见');
    await page(ctx, ctx.evidence.linearAddress); await ctx.hold(3);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
