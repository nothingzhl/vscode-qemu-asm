const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function uri(file) {
  return { scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href };
}
function isolatedController(vscode, fileSystem = fs) {
  const cache = new Map();
  const modules = new Set(['machineProfiles.js', 'projects.js']);
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const original = createRequire(filename);
    const require = request => {
      if (request === 'vscode') return vscode;
      if (request === 'node:fs/promises') return fileSystem;
      const resolved = original.resolve(request);
      return modules.has(path.basename(resolved)) && path.dirname(resolved) === path.dirname(filename)
        ? load(resolved) : original(request);
    };
    const wrapper = vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + require('node:fs').readFileSync(filename, 'utf8') + '\n})', { filename });
    wrapper(require, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  return load(path.resolve(__dirname, '../dist/integration/vscode/machineProfiles.js')).MachineProfiles;
}
const configuration = {
  machineProfiles: { small: { memoryMiB: 16 }, normal: { memoryMiB: 64 } },
  defaultMachineProfile: 'small'
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile selection '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folders = ['first workspace', 'second workspace'].map(name => ({ name, uri: uri(path.join(root, name)) }));
  const settings = new Map(folders.map(folder => [folder.uri.toString(), {}]));
  const values = new Map(), updates = [], notifications = [], opened = [];
  const picker = { entered: deferred(), chosen: deferred() };
  let pausedRead;
  const fileSystem = { ...fs, async readFile(file, ...options) {
    const contents = await fs.readFile(file, ...options);
    if (pausedRead?.file === file) {
      const pause = pausedRead;
      pausedRead = undefined;
      pause.entered.resolve();
      await pause.resume.promise;
    }
    return contents;
  } };
  const vscode = {
    Uri: { file: uri },
    Selection: class { constructor(start, end) { this.start = start; this.end = end; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: {
      isTrusted: true, workspaceFolders: folders,
      getConfiguration(_section, resource) {
        const current = settings.get(resource.toString());
        return {
          get: key => current[key],
          inspect: key => ({ workspaceFolderValue: current[key] })
        };
      },
      async openTextDocument(resource) {
        opened.push(resource.fsPath);
        const text = await fs.readFile(resource.fsPath, 'utf8');
        return { getText: () => text, positionAt: offset => ({ offset }) };
      }
    },
    window: {
      showWorkspaceFolderPick: async () => folders[0],
      showQuickPick(items) { picker.entered.resolve(items); return picker.chosen.promise; },
      showInformationMessage: async message => { notifications.push(message); },
      showTextDocument: async () => ({ revealRange() {} })
    }
  };
  const MachineProfiles = isolatedController(vscode, fileSystem);
  const profiles = new MachineProfiles({ workspaceState: {
    get: key => values.get(key),
    async update(key, value) { updates.push({ key, value }); value === undefined ? values.delete(key) : values.set(key, value); }
  } }, () => { if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust revoked'); });
  async function write(folder, data = configuration, projectDirectory = '.') {
    const project = path.join(folder.uri.fsPath, projectDirectory);
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'qemu-asm.json'), JSON.stringify(data));
    return project;
  }
  for (const folder of folders) await write(folder);
  const select = (folder, name) => profiles.select({ workspaceUri: folder.uri.toString(), ...(name === undefined ? {} : { name }) });
  const pauseRead = file => {
    pausedRead = { file, entered: deferred(), resume: deferred() };
    return pausedRead;
  };
  return { profiles, folders, settings, values, updates, notifications, opened, picker, vscode, write, select, pauseRead };
}

test('cancelled profile picker preserves the previous project selection without notification', async t => {
  const f = await fixture(t), folder = f.folders[0];
  await f.select(folder, 'normal');
  const before = f.updates.length, messages = f.notifications.length;
  const selecting = f.select(folder);
  await f.picker.entered.promise;
  f.picker.chosen.resolve(undefined);
  assert.equal(await selecting, undefined);
  assert.equal(f.updates.length, before);
  assert.equal(f.notifications.length, messages);
  assert.equal((await f.profiles.read(true, folder)).machineProfile.name, 'normal');
});

test('workspace and project roots independently own remembered choices; launch override does not replace them', async t => {
  const f = await fixture(t), [first, second] = f.folders;
  await f.select(first, 'normal');
  assert.equal((await f.profiles.read(true, second)).machineProfile.name, 'small');
  const explicit = await f.profiles.read(true, first, 'small');
  assert.equal(explicit.machineProfile.source, 'launch');
  assert.equal((await f.profiles.read(true, first)).machineProfile.name, 'normal');
  await f.write(first, configuration, 'other project');
  f.settings.get(first.uri.toString()).projectDirectory = 'other project';
  assert.equal((await f.profiles.read(true, first)).machineProfile.source, 'default');
  f.settings.get(first.uri.toString()).projectDirectory = '.';
  assert.equal((await f.profiles.read(true, first)).machineProfile.name, 'normal');
  await f.select(first, null);
  assert.equal((await f.profiles.read(true, first)).machineProfile.source, 'default');
});

test('a directory change during resolution cannot apply another project’s remembered profile', async t => {
  const f = await fixture(t), folder = f.folders[0];
  await f.select(folder, 'normal');
  const otherRoot = await f.write(folder, configuration, 'other project');
  const reading = f.profiles.read(true, folder);
  f.settings.get(folder.uri.toString()).projectDirectory = 'other project';
  const project = await reading;
  assert.equal(project.machineProfile.name, project.root === otherRoot ? 'small' : 'normal');
});

test('settings changed while the real config file is being read cannot parse old contents against a new root', async t => {
  const f = await fixture(t), folder = f.folders[0];
  await f.write(folder, { ...configuration, source: 'original.asm' });
  await f.write(folder, { ...configuration, source: 'different.asm' }, 'other project');
  const settings = f.settings.get(folder.uri.toString());
  settings.qemuPath = 'original-qemu';
  settings.qemuArgs = ['-m', '16M'];
  await f.select(folder, 'normal');
  const pause = f.pauseRead(path.join(folder.uri.fsPath, 'qemu-asm.json'));
  const reading = f.profiles.read(true, folder);
  await pause.entered.promise;
  settings.projectDirectory = 'other project';
  settings.qemuPath = 'different-qemu';
  settings.qemuArgs = ['-m', '128M'];
  pause.resume.resolve();
  const project = await reading;
  assert.equal(project.root, folder.uri.fsPath);
  assert.equal(project.source, path.join(folder.uri.fsPath, 'original.asm'));
  assert.equal(project.qemu, 'original-qemu');
  assert.deepEqual(project.qemuArgs, ['-m', '16M']);
  assert.equal(project.machineProfile.name, 'normal');
});

for (const change of ['trust', 'workspace', 'project directory', 'removed profile', 'invalid JSON']) {
  test(`profile selection rejects ${change} changes while the picker is open and keeps remembered state`, async t => {
    const f = await fixture(t), folder = f.folders[0];
    await f.select(folder, 'small');
    const before = [...f.values], updates = f.updates.length;
    const selecting = f.select(folder);
    const items = await f.picker.entered.promise;
    if (change === 'trust') f.vscode.workspace.isTrusted = false;
    if (change === 'workspace') f.vscode.workspace.workspaceFolders = [f.folders[1]];
    if (change === 'project directory') {
      await f.write(folder, configuration, 'other project');
      f.settings.get(folder.uri.toString()).projectDirectory = 'other project';
    }
    if (change === 'removed profile') await f.write(folder, {
      machineProfiles: { small: { memoryMiB: 16 } }, defaultMachineProfile: 'small'
    });
    if (change === 'invalid JSON') await fs.writeFile(path.join(folder.uri.fsPath, 'qemu-asm.json'), '{bad JSON');
    f.picker.chosen.resolve(items.find(item => item.profile === 'normal'));
    await assert.rejects(selecting, /Trust|工作区|项目目录|方案不存在|qemu-asm\.json/);
    assert.equal(f.updates.length, updates);
    assert.deepEqual([...f.values], before);
  });
}

test('deleted remembered and explicit launch profiles fail instead of silently using the project default', async t => {
  const f = await fixture(t), folder = f.folders[0];
  await f.select(folder, 'normal');
  await f.write(folder, { machineProfiles: { small: {} }, defaultMachineProfile: 'small' });
  await assert.rejects(f.profiles.read(true, folder), /方案不存在.*normal/);
  await assert.rejects(f.profiles.read(true, folder, 'missing'), /方案不存在.*missing/);
  await f.select(folder, null);
  assert.equal((await f.profiles.read(true, folder)).machineProfile.name, 'small');
});

test('configure opens the existing project file without changing its bytes or the remembered profile', async t => {
  const f = await fixture(t), folder = f.folders[0];
  await f.select(folder, 'normal');
  const file = path.join(folder.uri.fsPath, 'qemu-asm.json');
  const before = await fs.readFile(file, 'utf8'), updates = f.updates.length;
  await f.profiles.configure({ workspaceUri: folder.uri.toString() });
  assert.deepEqual(f.opened, [file]);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(f.updates.length, updates);
});

test('untrusted and malformed command requests do not persist a choice or open a file', async t => {
  const f = await fixture(t);
  for (const input of [null, 'normal', [], { name: 2 }, { workspaceUri: 1 }, { unknown: true }])
    await assert.rejects(f.profiles.select(input), /参数/);
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.select(f.folders[0], 'normal'), /Trust/);
  await assert.rejects(f.profiles.configure(), /Trust/);
  assert.equal(f.updates.length, 0);
  assert.equal(f.opened.length, 0);
});
