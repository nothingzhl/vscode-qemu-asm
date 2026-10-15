const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { QemuScreen } = require('../dist/display/screen');
const { ScreenFrames, ppmToPng } = require('../dist/display/frames');

const ppm = (header = 'P6\n1 1\n255\n', pixel = [1, 2, 3]) =>
  Buffer.concat([Buffer.from(header), Buffer.from(pixel)]);

test('screen cache reuses unchanged bytes and replaces pixels, dimensions and PPM metadata safely', () => {
  const frames = new ScreenFrames();
  const first = frames.convert(ppm());
  assert.equal(frames.convert(Buffer.from(ppm())), first);
  const metadata = frames.convert(ppm('P6\n# QEMU metadata\n1 1\n255\n'));
  assert.notEqual(metadata, first);
  assert.deepEqual(metadata.png, first.png);
  const changed = frames.convert(ppm(undefined, [1, 2, 4]));
  assert.notDeepEqual(changed.png, first.png);
  const resized = frames.convert(ppm('P6\n2 1\n255\n', [1, 2, 3, 4, 5, 6]));
  assert.deepEqual([resized.width, resized.height], [2, 1]);
  assert.equal(frames.convert(ppm()), frames.frame);
  assert.notEqual(frames.frame, first, 'only the latest encoded frame is kept');
});

test('invalid screenshots do not poison a valid cache and clear releases the last PNG', () => {
  const frames = new ScreenFrames();
  const first = frames.convert(ppm());
  assert.throws(() => frames.convert(Buffer.from('P6\n1 1\n255\n')), /长度/);
  assert.equal(frames.convert(ppm()), first);
  frames.clear();
  assert.equal(frames.frame, undefined);
  assert.equal(frames.digest, undefined);
  assert.notEqual(frames.convert(ppm()), first);
});

test('dispose waits for a pending screenshot read and prevents late cache retention', async t => {
  const fileSystem = require('node:fs/promises');
  const screen = await QemuScreen.create();
  t.after(() => screen.dispose());
  screen.client = { async command() {}, close() {} };
  let completeRead, started;
  const reading = new Promise(resolve => { started = resolve; });
  const pixels = new Promise(resolve => { completeRead = resolve; });
  const open = t.mock.method(fileSystem, 'open', async () => ({
    async stat() { return { isFile: () => true, size: ppm().length }; },
    async readFile() { started(); return pixels; },
    async close() {}
  }));
  const capturing = screen.capture();
  const rejected = assert.rejects(capturing, /停止/);
  await reading;
  let disposed = false;
  const disposal = screen.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  completeRead(ppm());
  await Promise.all([disposal, rejected]);
  open.mock.restore();
  assert.equal(screen.frames.frame, undefined);
  await assert.rejects(fileSystem.stat(screen.directory), { code: 'ENOENT' });
});

function panelHarness() {
  const posts = [], panels = [];
  const event = (target, name) => callback => { target[name] = callback; return { dispose() {} }; };
  const uri = { toString: () => '/extension' };
  const vscode = {
    ViewColumn: { Two: 2 }, Uri: { joinPath: () => uri },
    window: { createWebviewPanel() {
      const panel = { reveal() {}, dispose() { panel.closed(); }, webview: {
        cspSource: 'vscode-webview:', asWebviewUri: () => uri,
        postMessage: message => { posts.push(message); return Promise.resolve(true); }
      } };
      panel.onDidDispose = event(panel, 'closed');
      panel.webview.onDidReceiveMessage = event(panel, 'receive');
      panels.push(panel);
      return panel;
    } }
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/display/panel'), 'utf8'), {
    exports, Buffer, require: name => name === 'vscode' ? vscode : require(name)
  });
  const display = new exports.DisplayPanel({ extensionUri: uri });
  const show = () => { display.show(); panels.at(-1).receive({ type: 'ready' }); };
  return { display, posts, panels, show };
}

test('unchanged PNGs avoid duplicate webview transfers while a reopened panel replays its last frame', () => {
  const { display, posts, panels, show } = panelHarness();
  show();
  const first = ppmToPng(ppm());
  display.render(first);
  for (let count = 0; count < 1000; count++) display.render(first);
  assert.equal(posts.filter(post => post.type === 'frame').length, 1);
  display.options.onRefresh = async () => display.render(first);
  panels[0].receive({ type: 'refresh' });
  assert.equal(posts.filter(post => post.type === 'frame').length, 2, 'explicit refresh retries the same PNG');
  display.render(ppmToPng(ppm(undefined, [9, 8, 7])));
  assert.equal(posts.filter(post => post.type === 'frame').length, 3);
  panels[0].dispose();
  show();
  assert.equal(posts.filter(post => post.type === 'frame').length, 4);
  display.dispose();
  assert.equal(display.framePng, undefined);
  assert.equal(display.frame, undefined);
});
