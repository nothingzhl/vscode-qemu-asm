const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const turn = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const listeners = {}; const posts = []; const requests = [];
  const debug = { activeDebugSession: undefined };
  for (const name of ['onDidChangeActiveDebugSession', 'onDidStartDebugSession', 'onDidTerminateDebugSession']) debug[name] = callback => { listeners[name] = callback; return { dispose() { delete listeners[name]; } }; };
  const uri = value => ({ toString: () => value });
  const vscode = { debug, Uri: { joinPath: (root, ...parts) => uri([root.toString(), ...parts].join('/')) } };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/inspector/provider.js'), 'utf8'), { exports, require: name => name === 'vscode' ? vscode : name === './model' ? require('../dist/inspector/model') : require(name) });
  const provider = new exports.InspectorProvider({ extensionUri: uri('/extension') });
  const originalPost = provider.post.bind(provider); provider.post = message => { posts.push(message); originalPost(message); };
  const view = { visible: true, webview: { options: {}, cspSource: 'vscode-webview:', asWebviewUri: value => value, postMessage: () => Promise.resolve(true), onDidReceiveMessage: callback => { view.receive = callback; return { dispose() {} }; } }, onDidChangeVisibility: callback => { view.visibility = callback; return { dispose() {} }; }, onDidDispose: callback => { view.ended = callback; return { dispose() {} }; } };
  const session = (id = 'qemu') => ({ id, type: 'qemu-asm', customRequest: (command, args) => {
    requests.push({ id, command, args });
    return Promise.resolve({ address: args.address, count: 1, bytes: [1], mode: 'real16', follow: args.follow });
  } });
  const activate = session => { debug.activeDebugSession = session; listeners.onDidChangeActiveDebugSession(session); };
  const open = () => { provider.resolveWebviewView(view); view.receive({ type: 'ready' }); };
  return { provider, view, posts, requests, session, activate, open, latest: () => posts.filter(post => post.type === 'snapshot').at(-1) };
}
test('provider opens an already-stopped tracked session and renders real customRequest results', async () => {
  const h = harness(); const session = h.session(); const tracker = h.provider.createDebugAdapterTracker(session);
  tracker.onDidSendMessage({ type: 'event', event: 'stopped' }); assert.equal(h.requests.length, 0);
  h.open(); await turn(); assert.equal(h.requests.length, 1); assert.equal(h.latest().status, 'stopped'); assert.equal(h.latest().memory.bytes[0], 1);
  h.provider.dispose();
});
test('provider remembers stops in inactive QEMU sessions and restores a paused session after debugger switching', async () => {
  const h = harness(); const session = h.session(); const tracker = h.provider.createDebugAdapterTracker(session); h.open();
  h.activate({ id: 'other', type: 'node' }); tracker.onDidSendMessage({ type: 'event', event: 'stopped' });
  assert.equal(h.latest().status, 'idle'); assert.equal(h.requests.length, 0);
  h.activate(session); await turn(); assert.equal(h.latest().status, 'stopped'); assert.equal(h.requests.length, 1); h.provider.dispose();
});
test('failed step restores its previous state while a later stopped event wins over an older failure', async () => {
  const h = harness(); const session = h.session(); const tracker = h.provider.createDebugAdapterTracker(session); h.open();
  tracker.onWillReceiveMessage({ type: 'request', command: 'next', seq: 1 });
  tracker.onDidSendMessage({ type: 'response', command: 'next', request_seq: 1, success: false });
  assert.equal(h.latest().status, 'running'); assert.equal(h.requests.length, 0);
  tracker.onDidSendMessage({ type: 'event', event: 'stopped' }); await turn();
  tracker.onWillReceiveMessage({ type: 'request', command: 'next', seq: 2 }); assert.equal(h.latest().status, 'running');
  tracker.onDidSendMessage({ type: 'response', command: 'next', request_seq: 2, success: false }); await turn(); assert.equal(h.latest().status, 'stopped');
  tracker.onDidSendMessage({ type: 'event', event: 'continued' });
  tracker.onWillReceiveMessage({ type: 'request', command: 'next', seq: 3 });
  tracker.onDidSendMessage({ type: 'event', event: 'stopped' });
  tracker.onDidSendMessage({ type: 'response', command: 'next', request_seq: 3, success: false });
  assert.equal(h.latest().status, 'stopped');
  tracker.onWillReceiveMessage({ type: 'request', command: 'stepOut', seq: 4 });
  tracker.onWillReceiveMessage({ type: 'request', command: 'stepOut', seq: 5 });
  tracker.onDidSendMessage({ type: 'response', command: 'stepOut', request_seq: 4, success: false });
  tracker.onDidSendMessage({ type: 'response', command: 'stepOut', request_seq: 5, success: false });
  assert.equal(h.latest().status, 'stopped'); h.provider.dispose();
});
test('provider rejects expression addresses and generated HTML enforces external scripts with nonce CSP', async () => {
  const h = harness(); const session = h.session(); const tracker = h.provider.createDebugAdapterTracker(session); h.open();
  tracker.onDidSendMessage({ type: 'event', event: 'stopped' }); await turn(); const reads = h.requests.length;
  h.view.receive({ type: 'address', address: 'process.exit()' }); assert.equal(h.posts.at(-1).type, 'notice'); assert.equal(h.requests.length, reads);
  assert.match(h.view.webview.html, /default-src 'none'/); assert.match(h.view.webview.html, /script-src 'nonce-[^']+'/);
  assert.match(h.view.webview.html, /localResourceRoots|inspector\.js/); assert.doesNotMatch(h.view.webview.html, /onclick=|eval\(|unsafe-inline/);
  h.provider.dispose();
});
