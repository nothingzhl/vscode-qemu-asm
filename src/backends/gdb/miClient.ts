import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { requireExecutable } from '../../dependencies/tools';
import { localHost } from '../../platform/host';

import { MiRecord, parseMiRecord } from './miParser';

type Execute = (command: string) => Promise<MiRecord>;

/** 每个命令都带编号；事务从第一条命令直到恢复完成独占队列。 */
export class MiClient extends EventEmitter {
  private buffer = '';
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: {
    token: number;
    resolve: (value: MiRecord) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    output: string;
  };
  private closed = false;
  private disposal?: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeout = 15000,
    private readonly ownsProcessGroup = false,
    readonly executable?: string
  ) {
    super();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.readyPromise.catch(() => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => this.receive(text));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => this.emit('stderr', text));
    child.once('error', (error) => this.finish(error));
    // Only static start creates a private process group. Public constructor
    // consumers may supply a child in the extension's own process group.
    if (ownsProcessGroup) child.once('exit', () => localHost.terminateProcessTree(child, 'SIGKILL'));
    child.once('close', (code, signal) =>
      this.finish(new Error(signal ? `GDB 被信号 ${signal} 终止` : `GDB 已退出（${code ?? '未知'}）`))
    );
  }

  static async start(
    executable: string,
    args: string[],
    cwd: string,
    timeout = 15000,
    signal?: AbortSignal
  ): Promise<MiClient> {
    const cancellation = new Error('GDB/MI 启动已取消');
    if (signal?.aborted) throw cancellation;
    const tool = requireExecutable(executable, cwd, localHost);
    const child = localHost.spawn(tool.executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: localHost.identity.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...localHost.env, LC_ALL: 'C' }
    });
    const client = new MiClient(child, timeout, true, tool.executable);
    let timer: NodeJS.Timeout | undefined;
    let aborted = false;
    let onAbort: (() => void) | undefined;
    try {
      const abort = new Promise<never>((_, reject) => {
        onAbort = () => {
          aborted = true;
          reject(cancellation);
          void client.dispose();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      await Promise.race([
        abort,
        client.readyPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('等待 GDB/MI 启动超时')), timeout);
        })
      ]);
      if (aborted) throw cancellation;
      return client;
    } catch (error) {
      await client.dispose();
      throw aborted ? cancellation : error;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  command(command: string): Promise<MiRecord> {
    return this.transaction((execute) => execute(command));
  }

  transaction<T>(operation: (execute: Execute) => Promise<T>): Promise<T> {
    const task = this.queue.then(() => {
      if (this.closed) throw new Error('GDB/MI 会话已关闭');
      return operation((command) => this.execute(command));
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private execute(command: string): Promise<MiRecord> {
    if (this.closed) return Promise.reject(new Error('GDB/MI 会话已关闭'));
    if (!/^-[a-z][a-z0-9-]*(?:\s|$)/.test(command) || /[\r\n\0]/.test(command))
      return Promise.reject(new Error('MI 请求必须是单条命令'));
    if (this.pending) return Promise.reject(new Error('MI 事务不能同时发送多个命令'));
    return new Promise<MiRecord>((resolve, reject) => {
      const token = ++this.sequence;
      const timer = setTimeout(() => {
        const error = new Error('等待 GDB/MI 回复超时，会话已关闭');
        this.finish(error);
        void this.dispose();
      }, this.timeout);
      this.pending = { token, resolve, reject, timer, output: '' };
      this.child.stdin.write(`${token}${command}\n`, (error) => {
        if (error) {
          this.finish(error);
          void this.dispose();
        }
      });
    });
  }

  private receive(text: string): void {
    if (this.closed) return;
    this.buffer += text;
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.finish(new Error('GDB/MI 输出记录过大'));
      void this.dispose();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const record = parseMiRecord(line);
        if (!record) {
          this.emit('stdout', line + '\n');
          continue;
        }
        if (record.type === 'prompt') this.readyResolve();
        if (['console', 'target'].includes(record.type) && this.pending) {
          this.pending.output += record.text ?? '';
          if (this.pending.output.length > 4 * 1024 * 1024) throw new Error('GDB/MI 命令输出过大');
        }
        this.emit('record', record);
        if (record.type !== 'result') continue;
        const pending = this.pending;
        if (!pending || record.token !== pending.token) throw new Error('GDB/MI 回复编号与请求不一致');
        this.pending = undefined;
        clearTimeout(pending.timer);
        record.console = pending.output;
        if (record.class === 'error')
          pending.reject(
            new Error(typeof record.results.msg === 'string' ? record.results.msg : 'GDB 命令失败')
          );
        else pending.resolve(record);
      } catch (error) {
        this.finish(error as Error);
        void this.dispose();
        return;
      }
    }
  }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.readyReject(error);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.emit('terminated', error);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let complete!: () => void;
    this.disposal = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.finish(new Error('GDB/MI 会话已关闭'));
    if (this.child.exitCode !== null || this.child.signalCode !== null) complete();
    else {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(force);
        clearTimeout(limit);
        complete();
      };
      const terminate = (signal: 'SIGTERM' | 'SIGKILL') => {
        if (this.ownsProcessGroup) localHost.terminateProcessTree(this.child, signal);
        else this.child.kill(signal);
      };
      const force = setTimeout(() => {
        terminate('SIGKILL');
      }, 500);
      const limit = setTimeout(finish, 1800);
      this.child.once('close', finish);
      this.child.stdin.destroy();
      terminate('SIGTERM');
    }
    return this.disposal;
  }
}
