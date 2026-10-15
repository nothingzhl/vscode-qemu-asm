// Record actual public commands and the live display; no UI or guest mocks.
const path = require('node:path');
const assert = require('node:assert/strict');
const { runDemo, until, inView } = require('./common.cjs');

async function commandPalette(ctx, title) {
  // Return keyboard focus to a native editor before the workbench shortcut.
  await ctx.workbench.evaluate("document.querySelector('.monaco-editor textarea')?.focus()");
  await ctx.workbench.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'P', code: 'KeyP', modifiers: 10, windowsVirtualKeyCode: 80 });
  await ctx.workbench.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', modifiers: 10, windowsVirtualKeyCode: 80 });
  await until(() => ctx.workbench.evaluate("!!document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input')"), 'command palette');
  await ctx.workbench.send('Input.insertText', { text: title });
  await ctx.hold(0.75);
  const text = await ctx.workbench.evaluate("document.querySelector('.quick-input-widget')?.textContent || ''");
  assert(text.includes(title), `Command palette must offer ${title}: ${text}`);
  await ctx.workbench.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await ctx.workbench.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

runDemo({
  id: '01-build-display', title: '构建、运行与模拟显示器', previewStart: 13,
  host: path.join(__dirname, 'build-display-host.cjs'),
  async driver(ctx) {
    await ctx.mark('检查 NASM 与 QEMU 环境');
    await ctx.hold(1.5);
    await commandPalette(ctx, 'QEMU Assembly: 检查环境');
    await ctx.rpc('check', { external: true });
    await ctx.hold(3.5);
    await ctx.mark('构建 BIOS 引导盘，输出真实 NASM 编译日志');
    await commandPalette(ctx, 'QEMU Assembly: 构建');
    await ctx.rpc('build', { external: true });
    await ctx.hold(3.5);
    await ctx.mark('构建并运行：右侧显示真实 QEMU VGA 画面');
    await commandPalette(ctx, 'QEMU Assembly: 构建并运行');
    await ctx.rpc('run', { external: true });
    await ctx.refreshTargets();
    assert(ctx.monitor, 'Live QEMU monitor target must exist');
    await until(() => ctx.monitor.evaluate(inView("!d.getElementById('frame').hidden && d.getElementById('frame').naturalWidth > 0 && d.getElementById('status-dot').classList.contains('connected')")), 'actual live monitor frame');
    await ctx.hold(5);
    await ctx.mark('开启键盘输入，真实 BIOS 客户机回显 q');
    await ctx.click(ctx.monitor, '#keyboard', true);
    await ctx.hold(1.5);
    await ctx.click(ctx.monitor, '#screen', true);
    await ctx.monitor.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81, text: 'q', unmodifiedText: 'q' });
    await ctx.monitor.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81 });
    await ctx.rpc('keyboard');
    await ctx.hold(5);
    await ctx.mark('停止运行：释放 QEMU，显示器保留最后一帧');
    await commandPalette(ctx, 'QEMU Assembly: 停止');
    await ctx.rpc('stop', { external: true });
    await ctx.hold(4.5);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
