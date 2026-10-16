const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { QemuScreen, ppmToPng } = require('../../dist/display/screen');
const { InspectorSnapshots } = require('../../dist/inspector/snapshots');
const { measure, report, writeReport } = require('./measure.cjs');

function ppm(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset++) pixels[offset] = (offset * 7) % 251;
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

async function captures(name, source, changing) {
  const screen = await QemuScreen.create();
  let uniqueFrames = 0, previous;
  const file = path.join(screen.directory, 'screen.ppm');
  await fs.writeFile(file, source);
  // The local QMP substitute isolates the extension's file/hash/PNG pipeline.
  // real-display.cjs measures the same path with a running QEMU process.
  screen.client = { async command() {}, close() {} };
  try {
    const result = await measure(name, 100, async index => {
      if (changing) {
        source[source.length - 1] = index & 255;
        await fs.writeFile(file, source);
      }
      const frame = await screen.capture();
      if (previous !== frame.png) uniqueFrames++;
      previous = frame.png;
      assert.equal(frame.width, 640);
    });
    return { ...result, uniqueFrames };
  } finally { await screen.dispose(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--enforce')) assert.equal(typeof global.gc, 'function', 'Run with node --expose-gc');
  const filename = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
  const image = ppm(640, 400);
  const scenarios = [
    await measure('encode-640x400', 100, () => ppmToPng(image)),
    await measure('sha256-640x400', 100, () => createHash('sha256').update(image).digest()),
    await captures('static-capture-640x400', Buffer.from(image), false),
    await captures('changing-capture-640x400', Buffer.from(image), true)
  ];
  const snapshots = new InspectorSnapshots();
  const form = { tab: 'memory', memorySpace: 'virtual' };
  const value = {
    address: 0x7c00, bytes: Array.from({ length: 256 }, (_, index) => index), count: 256,
    mode: 'real16', follow: 'address', space: 'virtual', addressContext: 'virtual:unpaged',
    pagingEnabled: false, pageMappings: []
  };
  scenarios.push(await measure('memory-snapshot-256-bytes', 5000, index => {
    value.address = 0x7c00 + ((index + 1) % 64) * 128;
    snapshots.apply(form, { value });
  }));
  assert.ok(snapshots.seen.size <= 4096);
  const budget = { msPerOperation: 200, retainedHeapBytes: 20 * 1024 * 1024, retainedArrayBufferBytes: 20 * 1024 * 1024 };
  const result = report(scenarios, { budget, historyEntries: snapshots.seen.size });
  await writeReport(result, filename);
  if (args.includes('--enforce')) for (const scenario of scenarios) {
    assert.ok(scenario.msPerOperation < budget.msPerOperation, `${scenario.name}: severe latency regression`);
    assert.ok(scenario.retainedHeapBytes < budget.retainedHeapBytes, `${scenario.name}: excessive retained heap`);
    assert.ok(scenario.retainedArrayBufferBytes < budget.retainedArrayBufferBytes, `${scenario.name}: excessive retained buffers`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
