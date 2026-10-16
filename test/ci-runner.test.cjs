const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const runner = path.join(root, 'scripts', 'ci', 'run-suite.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu CI test, '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function invoke(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000
  });
}

test('CI runner rejects bad or ambiguous arguments before creating a result directory', t => {
  const output = path.join(temporary(t), 'must not exist');
  for (const args of [
    [], ['--suite', 'unknown'], ['--suite', 'toString'],
    ['--unexpected', 'full'], ['--suite'], ['--suite', 'host', '--output'],
    ['--suite', 'host', '--suite', 'full'], ['--suite', 'host', '--output', '--suite'],
    ['--suite', 'host', '--output', output, '--output', output]
  ]) {
    const flags = args.includes('--output') ? args : ['--output', output, ...args];
    const result = invoke([runner, ...flags]);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /Expected|--suite must be/);
    assert.equal(fs.existsSync(output), false);
  }
});

test('failed host setup preserves its child exit, logs and JSON instead of reporting success', t => {
  const directory = temporary(t);
  const output = path.join(directory, 'results with spaces, and commas');
  const summary = path.join(directory, 'summary.md');
  const result = invoke([runner, '--suite', 'host', '--output', output], {
    QEMU_ASM_HOST_PHASES: 'invalid-phase', GITHUB_STEP_SUMMARY: summary,
    // An invalid phase must fail before downloading or launching any editor.
    VSCODE_EXECUTABLE_PATH: path.join(directory, 'editor must not start')
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.passed, false);
  assert.equal(report.platform, process.platform);
  assert.equal(report.node, process.version);
  assert.equal(Number.isNaN(Date.parse(report.timestamp)), false);
  assert.equal(report.results.length, 1);
  const scenario = report.results[0];
  assert.equal(scenario.name, 'host-test');
  assert.equal(scenario.code, 1);
  assert.equal(scenario.passed, false);
  assert.equal(scenario.signal, null);
  assert(scenario.milliseconds >= 0);
  assert.match(fs.readFileSync(path.join(output, scenario.log), 'utf8'), /QEMU_ASM_HOST_PHASES must name/);
  assert.match(fs.readFileSync(summary, 'utf8'), /\| host-test \| FAIL \|/);
});

for (const [format, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`CI gate with ${format} requires success and rejects failed, cancelled or skipped jobs`, () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
      .replace(/\r?\n/g, newline);
    const gateJob = /\r?\n  ci:\r?\n/.exec(workflow)?.index ?? -1;
    assert(gateJob >= 0, 'CI result job must exist');
    const gate = workflow.slice(gateJob).match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/);
    assert(gate, 'CI result must expose its Node gate command');
    for (const state of ['success', 'failure', 'cancelled', 'skipped']) {
      const result = invoke(['-e', gate[1]], {
        JOB_RESULTS: JSON.stringify({ quality: { result: 'success' }, integration: { result: state } })
      });
      assert.equal(result.status, state === 'success' ? 0 : 1, `${state}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`integration: ${state}`));
    }
  });
}
