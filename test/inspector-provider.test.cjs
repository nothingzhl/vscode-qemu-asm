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
  const vscode = { debug, workspace: { isTrusted: true }, Uri: { joinPath: (root, ...parts) => uri([root.toString(), ...parts].join('/')) } };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/inspector/provider.js'), 'utf8'), { exports, require: name => name === 'vscode' ? vscode : name === './model' ? require('../dist/inspector/model') : require(name) });
  const provider = new exports.InspectorProvider({ extensionUri: uri('/extension') });
  const originalPost = provider.post.bind(provider); provider.post = message => { posts.push(message); originalPost(message); };
  const view = { visible: true, webview: { options: {}, cspSource: 'vscode-webview:', asWebviewUri: value => value, postMessage: () => Promise.resolve(true), onDidReceiveMessage: callback => { view.receive = callback; return { dispose() {} }; } }, onDidChangeVisibility: callback => { view.visibility = callback; return { dispose() {} }; }, onDidDispose: callback => { view.ended = callback; return { dispose() {} }; } };
  const session = (id = 'qemu') => ({ id, type: 'qemu-asm', customRequest: (command, args) => {
    requests.push({ id, command, args });
    return Promise.resolve({ address: args.address, count: 1, bytes: [1], mode: 'real16', follow: args.follow, space: args.space, addressContext: args.space === 'physical' ? 'physical' : 'virtual:unpaged', pagingEnabled: false, pageMappings: [] });
  } });
  const activate = session => { debug.activeDebugSession = session; listeners.onDidChangeActiveDebugSession(session); };
  const open = () => { provider.resolveWebviewView(view); view.receive({ type: 'ready' }); };
  return { provider, view, posts, requests, session, activate, open, vscode, latest: () => posts.filter(post => post.type === 'snapshot').at(-1) };
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

test('provider rejects running or untrusted mutations and validates watchpoint ranges without narrowing valid unaligned addresses', async () => {
  const h = harness(); const session = h.session(); const tracker = h.provider.createDebugAdapterTracker(session); h.open();
  h.view.receive({ type: 'watchpoint', action: 'add', address: '0x100001', size: 4, access: 'write' }); assert.equal(h.requests.length, 0);
  tracker.onDidSendMessage({ type: 'event', event: 'stopped' }); await turn();
  const changes = []; h.provider.model.changeWatchpoint = (...args) => { changes.push(args); return Promise.resolve(); };
  h.vscode.workspace.isTrusted = false; h.view.receive({ generation: h.latest().generation, sessionId: session.id, type: 'watchpoint', action: 'add', address: '0x100001', size: 4, access: 'write' });
  assert.equal(changes.length, 0); assert.match(h.posts.at(-1).message, /受信任/);
  h.vscode.workspace.isTrusted = true; h.view.receive({ generation: h.latest().generation, sessionId: session.id, type: 'watchpoint', action: 'add', address: '0xFFFFFFFF', size: 4, access: 'write' }); assert.equal(changes.length, 0);
  h.view.receive({ generation: h.latest().generation, sessionId: session.id, type: 'watchpoint', action: 'add', address: '0x100001', size: 4, access: 'write' });
  assert.equal(changes.length, 1); assert.equal(changes[0][1].address, 0x100001);
  h.provider.dispose();
});
test('provider keeps disassembly address jumps separate from memory and ignores next-page overflow', async () => {
  const h = harness(); h.open();
  h.view.receive({ type: 'disassemblyAddress', address: '0x100000' });
  assert.equal(h.provider.model.snapshot.form.disassemblyAddress, 0x100000); assert.equal(h.provider.model.snapshot.form.disassemblyFollow, false);
  assert.equal(h.provider.model.snapshot.form.address, 0x7c00);
  h.view.receive({ type: 'disassemblyAddress', address: '[eax]' }); assert.equal(h.posts.at(-1).type, 'notice');
  h.view.receive({ type: 'navigate', direction: 1 }); assert.equal(h.provider.model.snapshot.form.address, 0x7d00);
  assert.match(h.view.webview.html, /id="tab-disassembly"/); assert.match(h.view.webview.html, /id="tab-watchpoints"/); h.provider.dispose();
});
test('mutations from an older stopped snapshot cannot affect another session or stop generation', async () => {
  const h = harness(); const first = h.session(); const tracker = h.provider.createDebugAdapterTracker(first); h.open();
  tracker.onDidSendMessage({ type: 'event', event: 'stopped' }); await turn();
  const message = { type: 'instructionBreakpoint', address: 0x100000, enabled: true, generation: h.latest().generation, sessionId: first.id };
  const changes = []; h.provider.model.changeInstructionBreakpoint = (...args) => { changes.push(args); return Promise.resolve(); };
  tracker.onDidSendMessage({ type: 'event', event: 'continued' }); tracker.onDidSendMessage({ type: 'event', event: 'stopped' }); await turn();
  h.view.receive(message); assert.equal(changes.length, 0);
  const second = h.session('second'); h.activate(second); const otherTracker = h.provider.createDebugAdapterTracker(second);
  otherTracker.onDidSendMessage({ type: 'event', event: 'stopped' }); await turn();
  h.view.receive({ ...message, generation: h.latest().generation }); assert.equal(changes.length, 0);
  h.view.receive({ ...message, generation: h.latest().generation, sessionId: second.id }); assert.equal(changes.length, 1); h.provider.dispose();
});

test('paging input stays independent of memory and restores only validated form fields', async () => {
  const h = harness(); h.provider.resolveWebviewView(h.view);
  h.view.receive({ type: 'ready', form: { tab: 'paging', pagingAddress: 0xc0100000, memorySpace: 'physical', follow: 'esp', bytes: [1, 2] } });
  assert.equal(h.provider.model.snapshot.form.tab, 'paging'); assert.equal(h.provider.model.snapshot.form.pagingAddress, 0xc0100000);
  assert.equal(h.provider.model.snapshot.form.follow, 'address'); assert.equal(h.provider.model.snapshot.form.bytes, undefined);
  h.view.receive({ type: 'pagingAddress', address: '0xc0100004' }); assert.equal(h.provider.model.snapshot.form.pagingAddress, 0xc0100004); assert.equal(h.provider.model.snapshot.form.address, 0x7c00);
  h.view.receive({ type: 'pagingAddress', address: '[cr3]' }); assert.equal(h.posts.at(-1).type, 'notice'); assert.equal(h.provider.model.snapshot.form.pagingAddress, 0xc0100004);
  assert.match(h.view.webview.html, /id="tab-paging"/); assert.match(h.view.webview.html, /id="memory-space"/); assert.match(h.view.webview.html, /表项物理地址/); h.provider.dispose();
});
