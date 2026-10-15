import * as fs from 'node:fs';
import { HostIdentity, HostPlatform, localHost } from '../platform/host';

export type ExecutableStatus = 'resolved' | 'missing' | 'not-executable' | 'unsupported';

export interface ExecutableResolution {
  readonly requested: string;
  /** configured 表示入口包含路径；path 表示按当前扩展宿主的 PATH 查找。 */
  readonly source: 'configured' | 'path';
  readonly status: ExecutableStatus;
  /** 启动路径保留符号链接；canonicalPath 仅用于身份/诊断。 */
  readonly executable?: string;
  readonly canonicalPath?: string;
  readonly fingerprint?: string;
  readonly host: HostIdentity;
  readonly message?: string;
  readonly errorCode?: string;
}

export type ResolvedExecutable = ExecutableResolution & {
  readonly status: 'resolved';
  readonly executable: string;
};

function environment(host: HostPlatform, name: string): string | undefined {
  if (host.identity.platform !== 'win32') return host.env[name];
  // Node 在 Windows 将环境键视为大小写无关，重复键取字典序第一项。
  const key = Object.keys(host.env).sort().find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : host.env[key];
}

/**
 * 检查和运行共享的同步入口解析；不执行程序、不使用 shell、不改 PATH。
 * 裸命令只查 PATH；相对 PATH 段相对 cwd，空段表示 cwd。
 */
export function resolveExecutable(requested: string, cwd: string, host: HostPlatform = localHost): ExecutableResolution {
  const windows = host.identity.platform === 'win32';
  const source: ExecutableResolution['source'] = /[\\/]/.test(requested) || host.paths.isAbsolute(requested) ? 'configured' : 'path';
  const base = { requested, source, host: host.identity };
  const invalid = (message: string): ExecutableResolution => ({ ...base, status: 'unsupported', message, errorCode: 'EINVAL' });
  if (!requested.trim()) return invalid('工具入口不能为空，请配置可执行文件路径或 PATH 命令。');
  if (requested.includes('\0')) return invalid('工具入口含有 NUL 字符。');
  if (/^["']|["']$/.test(requested)) return invalid('工具路径不需要外层引号；含空格的路径直接填写，参数另用数组传入。');
  if (/^[a-z]:(?:[^\\/]|$)/i.test(requested)) return invalid('不支持盘符相对路径，请使用完整绝对路径。');
  if (windows && /^[\\/](?![\\/])/.test(requested)) return invalid('不支持依赖当前盘符的根路径，请使用完整绝对路径。');
  if (!windows && /^(?:[a-z]:[\\/]|\\\\)/i.test(requested)) return invalid('Windows 工具路径不能在当前非 Windows 扩展宿主执行，请配置宿主上的路径。');

  const failure = (executable: string, status: Exclude<ExecutableStatus, 'resolved'>, message: string, errorCode: string): ExecutableResolution =>
    ({ ...base, status, executable, message, errorCode });
  const inspect = (executable: string): ExecutableResolution => {
    let stat: fs.Stats;
    try { stat = fs.statSync(executable); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'EIO';
      if (code === 'ENOENT' || code === 'ENOTDIR') return failure(executable, 'missing', `找不到工具：${executable}`, code);
      if (code === 'EACCES' || code === 'EPERM') return failure(executable, 'not-executable', `无法访问工具：${executable}（${code}）`, code);
      return failure(executable, 'unsupported', `无法检查工具：${executable}（${code}）`, code);
    }
    if (!stat.isFile()) return failure(executable, 'not-executable', `工具入口不是普通文件：${executable}`, 'EACCES');
    const extension = host.paths.extname(executable).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      return failure(executable, 'unsupported', `不能直接启动 ${extension} 入口：${executable}；请显式配置解释器可执行文件，并通过参数数组传入脚本。`, 'EINVAL');
    }
    if (windows && extension !== '.exe' && extension !== '.com') {
      return failure(executable, 'unsupported', `Windows 工具入口需要 .exe/.com 可执行文件：${executable}；脚本请显式指定解释器。`, 'EINVAL');
    }
    try { fs.accessSync(executable, windows ? fs.constants.F_OK : fs.constants.X_OK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'EACCES';
      return failure(executable, code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'not-executable', `工具无法执行：${executable}（${code}）`, code);
    }
    let canonicalPath: string | undefined;
    try { canonicalPath = fs.realpathSync(executable); } catch { /* 实际启动仍使用上述入口，不猜测符号链接目标。 */ }
    return {
      ...base, status: 'resolved', executable, canonicalPath,
      fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
    };
  };

  const names = windows && !host.paths.extname(requested)
    ? [...new Set((environment(host, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(extension => /^\.[a-z0-9]+$/i.test(extension)).map(extension => requested + extension))]
    : [requested];
  // PATHEXT 为空时不偷偷添加另一套候选规则。
  if (!names.length) return invalid('PATHEXT 没有可用的文件扩展名，请配置完整 .exe/.com 路径。');
  const directories = source === 'configured'
    ? [cwd]
    : (environment(host, 'PATH') ?? (windows ? '' : '/usr/bin:/bin')).split(host.paths.delimiter);
  let rejected: ExecutableResolution | undefined;
  for (const directory of directories) {
    for (const name of names) {
      const executable = source === 'configured' ? host.paths.resolve(cwd, name) : host.paths.resolve(cwd, directory, name);
      const result = inspect(executable);
      if (result.status === 'resolved' || result.status === 'unsupported') return result;
      // POSIX PATH 允许越过缺少执行权限的同名文件；没有成功项时保留首个原因。
      if (result.status !== 'missing' && !rejected) rejected = result;
      if (source === 'configured' && !windows) return result;
    }
  }
  if (rejected) return rejected;
  if (source === 'configured') return failure(host.paths.resolve(cwd, names[0]), 'missing', `找不到工具：${host.paths.resolve(cwd, requested)}`, 'ENOENT');
  return { ...base, status: 'missing', message: `当前扩展宿主的 PATH 中找不到工具：${requested}`, errorCode: 'ENOENT' };
}

export function requireExecutable(resolution: ExecutableResolution): ResolvedExecutable;
export function requireExecutable(requested: string, cwd: string, host?: HostPlatform): ResolvedExecutable;
export function requireExecutable(requested: string | ExecutableResolution, cwd?: string, host: HostPlatform = localHost): ResolvedExecutable {
  const resolution = typeof requested === 'string' ? resolveExecutable(requested, cwd ?? '.', host) : requested;
  if (resolution.status === 'resolved' && resolution.executable) return resolution as ResolvedExecutable;
  const code = resolution.errorCode ?? (resolution.status === 'missing' ? 'ENOENT' : resolution.status === 'not-executable' ? 'EACCES' : 'EINVAL');
  const error: NodeJS.ErrnoException = new Error(`[${code}] ${resolution.message ?? `工具无法执行：${resolution.requested}`}`);
  error.code = code;
  error.path = resolution.executable ?? resolution.requested;
  throw error;
}
