const { performance } = require('node:perf_hooks');

function memory() {
  const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage();
  return { heapUsed, rss, external, arrayBuffers };
}

async function collect() {
  global.gc?.();
  await new Promise(resolve => setImmediate(resolve));
  global.gc?.();
}

async function measure(name, iterations, action) {
  await action(-1);
  await collect();
  const before = memory();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) await action(index);
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const peak = memory();
  await collect();
  const after = memory();
  return {
    name, iterations, elapsedMs, msPerOperation: elapsedMs / iterations,
    cpuMs: (used.user + used.system) / 1000,
    retainedHeapBytes: after.heapUsed - before.heapUsed,
    retainedArrayBufferBytes: after.arrayBuffers - before.arrayBuffers,
    before, after, observed: peak
  };
}

function report(scenarios, details = {}) {
  return {
    schemaVersion: 1, timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    scope: 'Node process running compiled extension modules; excludes VS Code UI and child processes',
    forcedGc: typeof global.gc === 'function',
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024, scenarios, ...details
  };
}

async function writeReport(result, filename) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  if (filename) {
    await fs.mkdir(path.dirname(path.resolve(filename)), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { measure, memory, report, writeReport };
