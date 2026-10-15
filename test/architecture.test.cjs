const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { RunSession } = require('../dist/application/runSession');
const { SourceValues } = require('../dist/application/source/values');

function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith('.ts') ? [file] : [];
  });
}

test('architecture boundaries prevent protocol and editor dependencies leaking into consumers', () => {
  const root = path.resolve(__dirname, '../src');
  for (const area of ['ports', 'domain', 'application', 'integration/dap']) {
    for (const file of files(path.join(root, area))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = node => {
        let specifier;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier?.text;
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'require') specifier = node.arguments[0]?.text;
        if (specifier) {
          const target = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier;
          assert.ok(!/[\\/]backends[\\/]|iced-x86/.test(target), `${file} imports implementation ${specifier}`);
          assert.ok(!/[\\/]debug[\\/](?:mi|runtime|gdbRuntime|adapter|cAdapter|disassembly)$/.test(target), `${file} imports compatibility entry ${specifier}`);
          if (area !== 'integration/dap') assert.notEqual(specifier, 'vscode', `${file} imports editor API`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function resources() {
  const exited = deferred();
  const calls = [];
  return {
    calls, exited,
    machine: {
      async start() { calls.push('start'); return { executable: '/fake/vm', exited: exited.promise }; },
      async dispose() { calls.push('machine.dispose'); }
    },
    display: { async connect() { calls.push('connect'); }, async dispose() { calls.push('display.dispose'); } }
  };
}

test('stop waits for pending allocation and releases cancelled resources without starting them', async () => {
  const session = new RunSession(), allocated = deferred(), owned = resources();
  const start = session.start(() => allocated.promise);
  const rejected = assert.rejects(start, /取消/);
  let stopped = false;
  const stop = session.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  allocated.resolve(owned);
  await Promise.all([stop, rejected]);
  assert.deepEqual(owned.calls, ['machine.dispose', 'display.dispose']);
});

test('exit and explicit stop share cleanup; a later session keeps its own resources', async () => {
  const session = new RunSession(), first = resources(), second = resources();
  await session.start(async () => first);
  await assert.rejects(session.start(async () => second), /先停止/);
  first.exited.resolve();
  await session.stop();
  await session.start(async () => second);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first.calls, ['start', 'connect', 'machine.dispose', 'display.dispose']);
  assert.deepEqual(second.calls, ['start', 'connect']);
  await session.stop();
});

test('display failure releases the run machine before start rejects', async () => {
  const session = new RunSession(), owned = resources();
  owned.display.connect = async () => { throw new Error('display connection failed'); };
  await assert.rejects(session.start(async () => owned), /display connection failed/);
  assert.deepEqual(owned.calls, ['start', 'machine.dispose', 'display.dispose']);
  await session.stop();
  assert.equal(owned.calls.length, 3);
});

test('source values consume typed capabilities without VM, MI transport or physical-memory support', async () => {
  const released = [];
  const backend = {
    stack: { async frames() { return [{ level: 0, name: 'kernel', line: 9, source: '/kernel.c', address: 0x1000 }]; } },
    variables: {
      async create() { return { id: 'root', name: 'item', type: 'struct item', value: '{...}', childCount: 1, hasMore: false }; },
      async children() { return [{ id: 'child', name: 'count', type: 'int', value: '42', childCount: 0, hasMore: false }]; },
      async release(ids) { released.push(...ids); }
    }
  };
  const values = new SourceValues(() => backend, () => backend);
  const [frame] = await values.frames();
  const value = await values.createVariable('item', frame.level);
  const children = await values.variables(value.variablesReference, 0, 10);
  assert.equal(children[0].value, '42');
  await values.expireVariables();
  assert.deepEqual(released, ['root']);
  assert.throws(() => values.frame(frame.id), /过期/);
});
