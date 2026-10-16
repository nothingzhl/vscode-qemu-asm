const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(20); }
  throw new Error(`Timeout: ${description}`);
}
class DapClient {
  constructor(adapter) {
    this.adapter = adapter; this.seq = 1; this.pending = new Map(); this.events = [];
    this.listener = adapter.onDidSendMessage(message => {
      if (message.type === 'event') this.events.push(message);
      if (message.type !== 'response') return;
      const task = this.pending.get(message.request_seq); if (!task) return;
      this.pending.delete(message.request_seq); clearTimeout(task.timer);
      if (message.success) task.resolve(message.body || {});
      else task.reject(new Error(`${message.command}: ${message.message}`));
    });
  }
  request(command, args = {}) {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`DAP ${command} timeout`)); }, 30000);
      this.pending.set(seq, { resolve, reject, timer });
      this.adapter.handleMessage({ seq, type: 'request', command, arguments: args });
    });
  }
  event(name, after = 0) { return until(() => this.events.slice(after).find(item => item.event === name), name); }
  async stoppedAfter(command, args = { threadId: 1 }) {
    const start = this.events.length; await this.request(command, args);
    return (await this.event('stopped', start)).body;
  }
  async launch() {
    await this.request('initialize');
    const start = this.events.length;
    await this.request('launch', { stopOnEntry: true });
    await this.event('initialized', start); await this.request('configurationDone');
    assert.equal((await this.event('stopped', start)).body.reason, 'entry');
  }
  async disconnect() {
    const start = this.events.length; await this.request('disconnect'); await this.event('terminated', start);
  }
  async dispose() {
    await this.adapter.dispose(); this.listener.dispose();
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('disposed')); }
    this.pending.clear();
  }
}
module.exports = { DapClient, until };
