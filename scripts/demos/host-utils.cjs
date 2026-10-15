const fs = require('node:fs/promises');
const vscode = require('vscode');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timeout: ${description}`);
}
// A temporary local control channel for recording scripts, never extension code.
async function serve(evidence, handler) {
  const ready = process.env.QEMU_ASM_DEMO_READY;
  if (!ready) throw new Error('QEMU_ASM_DEMO_READY is required');
  await fs.writeFile(ready, JSON.stringify({ ...evidence, vscodeVersion: vscode.version,
    extensionVersion: vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm')?.packageJSON.version }, null, 2));
  let previous;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    try { await fs.access(`${ready}.done`); return; } catch {}
    let request;
    try { request = JSON.parse(await fs.readFile(`${ready}.request`, 'utf8')); } catch {}
    if (request && request.serial !== previous) {
      previous = request.serial;
      try {
        const result = await handler(request.action, request.args || {});
        await fs.writeFile(`${ready}.reply`, JSON.stringify({ serial: request.serial, result }));
      } catch (error) {
        await fs.writeFile(`${ready}.reply`, JSON.stringify({ serial: request.serial, error: error.stack || String(error) }));
      }
    }
    await delay(50);
  }
  throw new Error('Recording controller timed out');
}
module.exports = { serve, until, delay, vscode };
