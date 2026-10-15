import { ChildProcess } from 'node:child_process';
import { HostPlatform, localHost, TerminationSignal } from './host';
import { ExecutableResolution, requireExecutable, resolveExecutable } from '../dependencies/tools';

export interface OwnedProcess {
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<void>;
  tool: ExecutableResolution;
}

/** 只管理自身启动的进程，平台层不决定工作区信任或项目构建策略。 */
export class Processes {
  private children = new Set<ChildProcess>();
  private stopping = new WeakSet<ChildProcess>();
  private closed = false;

  constructor(readonly host: HostPlatform = localHost) { }

  start(command: string, args: string[], cwd: string, log: (text: string) => void): OwnedProcess {
    if (this.closed) throw new Error('插件正在退出');
    const tool = resolveExecutable(command, cwd, this.host);
    const executable = requireExecutable(tool).executable;
    // External builders create descendants. A dedicated process group keeps
    // stop/timeout restricted to our own launch, including its compilers.
    const child = this.host.spawn(executable, args, {
      cwd, env: this.host.env, shell: false, windowsHide: true,
      detached: this.host.identity.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.add(child);
    // A leader may finish while an unref'ed compiler still runs. Clean its
    // process group at exit, before forgetting the live PID.
    child.once('exit', () => this.terminate(child, 'SIGKILL'));
    child.stdout?.setEncoding('utf8').on('data', text => log(text));
    child.stderr?.setEncoding('utf8').on('data', text => log(text));
    const ready = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        this.children.delete(child);
        if (code === 0 || this.stopping.has(child)) resolve();
        else reject(new Error(signal ? `${command} 被信号 ${signal} 终止` : `${command} 退出码 ${code}`));
      });
    });
    void done.catch(() => undefined);
    return { child, ready, done, tool };
  }

  terminate(child: ChildProcess, signal: TerminationSignal): void {
    if (!this.children.has(child) || child.pid === undefined) return;
    this.host.terminateProcessTree(child, signal);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.children].map(child => new Promise<void>((resolve) => {
      if (!this.children.has(child)) { resolve(); return; }
      this.stopping.add(child);
      const timer = setTimeout(() => this.terminate(child, 'SIGKILL'), 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      this.terminate(child, 'SIGTERM');
    })));
  }

  async dispose(): Promise<void> { this.closed = true; await this.stop(); }
}

export async function execute(processes: Processes, command: string, args: string[], cwd: string, log: (text: string) => void, timeout = 15000, cancelled: () => boolean = () => false): Promise<void> {
  if (cancelled()) throw new Error('构建已停止');
  const run = processes.start(command, args, cwd, log);
  let expired = false;
  let stopped = false;
  const terminate = () => { if (processes.terminate) processes.terminate(run.child, 'SIGKILL'); else run.child.kill('SIGKILL'); };
  const timer = setTimeout(() => { expired = true; terminate(); }, timeout);
  const cancellation = setInterval(() => { if (cancelled()) { stopped = true; terminate(); } }, 50);
  try { await run.ready; await run.done; if (expired) throw new Error(`${command} 执行超时`); if (stopped || cancelled()) throw new Error('构建已停止'); }
  catch (error) { if (expired) throw new Error(`${command} 执行超时`); if (stopped || cancelled()) throw new Error('构建已停止'); throw error; }
  finally { clearTimeout(timer); clearInterval(cancellation); }
}
