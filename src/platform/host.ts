import { ChildProcess, spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HostIdentity {
  /** 扩展实际执行的平台，不是 VS Code UI 平台或客体架构。 */
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
}

export type TerminationSignal = 'SIGTERM' | 'SIGKILL';

/** 本机平台的窄边界；文件操作继续使用 Node 的文件系统 API。 */
export interface HostPlatform {
  readonly identity: HostIdentity;
  readonly paths: typeof path;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn: typeof spawn;
  /** 调用者必须确认 child 属于自己，POSIX child 必须以 detached 进程组启动。 */
  terminateProcessTree(child: ChildProcess, signal: TerminationSignal): void;
}

export const localHost: HostPlatform = {
  identity: Object.freeze({ platform: process.platform, arch: process.arch, release: os.release() }),
  paths: path,
  env: process.env,
  spawn,
  terminateProcessTree(child, signal): void {
    if (child.pid === undefined) return;
    if (this.identity.platform === 'win32') {
      const killer = this.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore', env: this.env,
      });
      killer.once('error', () => child.kill(signal));
      killer.once('exit', code => { if (code !== 0) child.kill(signal); });
      return;
    }
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
  },
};
