// Run compiled-product integration scripts once each and preserve every result,
// including failures. No shell pipeline can hide a child exit status.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const native = [
  'integration', 'debug-runtime-integration', 'debug-integration',
  'stage-build-integration', 'protected-integration', 'inspection-integration',
  'watchpoint-runtime-integration', 'machine-debug-integration',
  'physical-memory-integration', 'paging-integration', 'display-integration'
];
const suites = {
  full: [...native, 'c-machine-integration', 'c-source-integration', 'dependency-integration'],
  native,
  'os-project': ['os-project-integration', 'os-project-host'],
  host: ['host-test']
};
const repository = path.resolve(__dirname, '../..');

function options(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.includes(key) || !argv[i + 1] ||
        argv[i + 1].startsWith('--') || result[key]) {
      throw new Error(`Expected ${allowed.map(name => `--${name} VALUE`).join(' ')}`);
    }
    result[key] = argv[i + 1];
  }
  return result;
}

async function runScript(name, output, env = process.env) {
  fs.mkdirSync(output, { recursive: true });
  const log = path.join(output, `${name}.log`);
  fs.writeFileSync(log, '');
  const started = performance.now();
  const child = spawn(process.execPath, [path.join(repository, 'scripts', `${name}.cjs`)], {
    cwd: repository, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      fs.appendFileSync(log, chunk);
      process.stdout.write(chunk);
    });
  }
  const status = await new Promise(resolve => {
    child.once('error', error => {
      fs.appendFileSync(log, `${error.stack}\n`);
      resolve({ code: null, signal: null, error: error.message });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const result = {
    name, ...status, passed: status.code === 0,
    milliseconds: Math.round(performance.now() - started), log: path.basename(log)
  };
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${name} (${result.milliseconds} ms)`);
  return result;
}

function writeResults(output, results, extra = {}) {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    schemaVersion: 1, timestamp: new Date().toISOString(),
    platform: process.platform, arch: process.arch, node: process.version,
    ...extra, passed: results.every(result => result.passed), results
  };
  fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map(result => `| ${result.name} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.milliseconds ?? '—'} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n| Scenario | Result | Duration (ms) |\n| --- | --- | ---: |\n${rows.join('\n')}\n`);
  }
  return report;
}

async function main() {
  const args = options(process.argv.slice(2), ['suite', 'output']);
  if (!Object.hasOwn(suites, args.suite)) throw new Error(`--suite must be ${Object.keys(suites).join(', ')}`);
  const output = path.resolve(args.output || `artifacts/${args.suite}`);
  const results = [];
  for (const name of suites[args.suite]) results.push(await runScript(name, output));
  const report = writeResults(output, results, {
    suite: args.suite, vscode: process.env.VSCODE_VERSION || null,
    hostPhases: process.env.QEMU_ASM_HOST_PHASES || null
  });
  if (!report.passed) process.exitCode = 1;
}

module.exports = { options, runScript, writeResults };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
