const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { QemuScreen } = require('../../dist/display/screen');
const { InspectorSnapshots } = require('../../dist/inspector/snapshots');
const { measure, report, writeReport } = require('./measure.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--enforce')) assert.equal(typeof global.gc, 'function', 'Run with node --expose-gc');
  const filename = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
  const ppm = Buffer.concat([Buffer.from('P6\n640 400\n255\n'), Buffer.alloc(640 * 400 * 3, 63)]);
  const screenshots = await measure('screen-create-capture-dispose', 100, async () => {
    const screen = await QemuScreen.create();
    screen.client = { async command() {}, close() {} };
    try {
      await fs.writeFile(path.join(screen.directory, 'screen.ppm'), ppm);
      await screen.capture();
    } finally { await screen.dispose(); }
    await assert.rejects(fs.stat(screen.directory), { code: 'ENOENT' });
  });
  const form = { tab: 'memory', memorySpace: 'virtual' };
  const value = {
    address: 0, bytes: Array.from({ length: 256 }, (_, index) => index), count: 256,
    mode: 'real16', follow: 'address', space: 'virtual', addressContext: 'virtual:unpaged',
    pagingEnabled: false, pageMappings: []
  };
  const history = await measure('memory-history-create-fill-clear', 100, index => {
    const snapshots = new InspectorSnapshots();
    for (let page = 0; page < 24; page++) {
      value.address = page * 256;
      value.bytes[0] = index & 255;
      snapshots.apply(form, { value });
    }
    assert.equal(snapshots.seen.size, 4096, 'history must remain bounded after scrolling');
    snapshots.clear();
    assert.equal(snapshots.seen.size, 0);
  });
  const scenarios = [screenshots, history];
  const budget = { retainedHeapBytes: 8 * 1024 * 1024, retainedArrayBufferBytes: 8 * 1024 * 1024 };
  await writeReport(report(scenarios, { budget, notes: [
    'Repeated screen lifecycle uses local file/QMP substitution; it does not start 100 QEMU guests.',
    'The real-display benchmark and host tests validate transport and guest lifetime separately.'
  ] }), filename);
  if (args.includes('--enforce')) for (const scenario of scenarios) {
    assert.ok(scenario.retainedHeapBytes < budget.retainedHeapBytes, `${scenario.name}: retained heap grew excessively`);
    assert.ok(scenario.retainedArrayBufferBytes < budget.retainedArrayBufferBytes, `${scenario.name}: native buffers grew excessively`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
