import { randomUUID } from 'node:crypto';
import type { Project } from '../core';
import { localHost, type HostPlatform } from '../platform/host';
import { execute, Processes } from '../platform/processes';
import { resolveExecutable, type ExecutableResolution } from './tools';
import { CapabilityLedger, type CapabilityReport } from './capabilities';

export type EnvironmentToolId = 'nasm' | 'qemu' | 'gdb' | 'builder';

export interface EnvironmentToolCheck {
  id: EnvironmentToolId;
  resolution: ExecutableResolution;
  status: 'passed' | 'failed' | 'not-run';
  evidence: 'not-checked' | 'executable';
  reason: string;
  checkedAt: string;
  version?: string;
  /** Bounded diagnostic output; it is never interpreted as protocol support. */
  output?: string;
}

export interface EnvironmentReport {
  schemaVersion: 1;
  checkedAt: string;
  host: HostPlatform['identity'];
  project: { root: string; build: 'nasm' | 'external'; debug: 'nasm' | 'c' };
  status: 'passed' | 'failed' | 'cancelled';
  tools: EnvironmentToolCheck[];
  capabilities: CapabilityReport;
  /** A separately scoped snapshot from the active adapter; never merged into basic checks. */
  runtimeReport?: CapabilityReport;
}

export interface EnvironmentCheckOptions {
  host?: HostPlatform;
  timeout?: number;
  signal?: AbortSignal;
  cancelled?: () => boolean;
  runtimeReport?: CapabilityReport;
}

const knownTools: Record<Exclude<EnvironmentToolId, 'builder'>, { args: string[]; identity: RegExp }> = {
  nasm: { args: ['-v'], identity: /^\s*NASM version\s+([0-9]+\.[0-9]+[\w.+~_-]*)\b/im },
  qemu: { args: ['--version'], identity: /^\s*QEMU emulator version\s+([0-9]+\.[0-9]+[\w.+~_-]*)\b/im },
  gdb: { args: ['--version'], identity: /^\s*GNU gdb(?:\s+\([^\r\n]*\))?\s+([0-9]+\.[0-9]+[\w.+~_-]*)\b/im },
};

/** Basic checks only. Workspace Trust is required at the caller before entering this operation. */
export async function checkEnvironment(project: Project, processes: Processes, options: EnvironmentCheckOptions = {}): Promise<EnvironmentReport> {
  const host = options.host ?? processes.host ?? localHost;
  if (host !== processes.host) throw new Error('依赖检查与进程执行必须使用同一宿主');
  const timeout = options.timeout ?? 5000;
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error('依赖检查超时必须为正数');
  const cancelled = () => !!options.signal?.aborted || !!options.cancelled?.();
  const checkedAt = new Date().toISOString();
  const requests: { id: EnvironmentToolId; requested: string; cwd: string }[] = [
    project.build
      ? { id: 'builder', requested: project.build.command, cwd: project.build.cwd }
      : { id: 'nasm', requested: project.nasm, cwd: project.root },
    { id: 'qemu', requested: project.qemu, cwd: project.root },
    ...(project.debug ? [{ id: 'gdb' as const, requested: project.debug.gdb, cwd: project.root }] : []),
  ];
  const tools: EnvironmentToolCheck[] = [];
  for (const request of requests) {
    const resolution = resolveExecutable(request.requested, request.cwd, host);
    const base = { id: request.id, resolution, checkedAt: new Date().toISOString() };
    if (cancelled()) {
      tools.push({ ...base, status: 'not-run', evidence: 'not-checked', reason: '检查已取消，未执行此工具' });
      continue;
    }
    if (resolution.status !== 'resolved' || !resolution.executable) {
      tools.push({ ...base, status: 'failed', evidence: 'not-checked', reason: resolution.message ?? `无法解析 ${request.requested}` });
      continue;
    }
    if (request.id === 'builder') {
      tools.push({ ...base, status: 'not-run', evidence: 'not-checked', reason: '已解析外部构建命令；基础检查不执行用户构建，也不追加版本参数' });
      continue;
    }
    const specification = knownTools[request.id];
    let output = '';
    try {
      await execute(processes, resolution.executable, specification.args, request.cwd, text => {
        // Cap retained output even if an unexpected executable prints indefinitely.
        if (output.length < 16384) output += text.slice(0, 16384 - output.length);
      }, timeout, cancelled);
      const match = specification.identity.exec(output);
      if (!match) {
        tools.push({ ...base, status: 'failed', evidence: 'executable', reason: '进程已退出，但输出无法识别为预期工具的版本；请检查工具路径', output: output.trim() });
        continue;
      }
      tools.push({ ...base, status: 'passed', evidence: 'executable', reason: '可执行身份与版本已识别；调试协议及功能仍需在实际会话验证', version: match[1], output: output.trim() });
    } catch (error) {
      tools.push({ ...base, status: cancelled() ? 'not-run' : 'failed', evidence: 'executable', reason: cancelled() ? '检查已取消' : (error instanceof Error ? error.message : String(error)), ...(output ? { output: output.trim() } : {}) });
    }
  }
  const scopeTools: Record<string, string> = {};
  for (const tool of tools) if (tool.resolution.status === 'resolved' && tool.resolution.executable) scopeTools[tool.id] = tool.resolution.executable;
  const ledger = new CapabilityLedger({
    sessionId: randomUUID(),
    targetId: `environment:${project.root}`,
    backend: project.debug ? 'c' : 'nasm',
    host: host.identity,
    tools: scopeTools,
    machine: project.qemuArgs,
  });
  return {
    schemaVersion: 1,
    checkedAt,
    host: { ...host.identity },
    project: { root: project.root, build: project.build ? 'external' : 'nasm', debug: project.debug ? 'c' : 'nasm' },
    status: cancelled() ? 'cancelled' : tools.some(tool => tool.status === 'failed') ? 'failed' : 'passed',
    tools,
    capabilities: ledger.snapshot(),
    ...(options.runtimeReport ? { runtimeReport: structuredClone(options.runtimeReport) } : {}),
  };
}

const toolLabels: Record<EnvironmentToolId, string> = { nasm: 'NASM', qemu: 'QEMU', gdb: 'GDB', builder: '外部构建器' };
const evidenceLabels = { 'not-checked': '未检查', executable: '可执行文件', protocol: '协议探针', integration: '集成验证' };

/** Plain text suitable for an OutputChannel, including explicit unverified boundaries. */
export function formatEnvironmentReport(report: EnvironmentReport): string {
  const lines = [
    'QEMU Assembly 依赖检查（基础）',
    `时间：${report.checkedAt}`,
    `扩展执行宿主：${report.host.platform} ${report.host.arch}（${report.host.release}）`,
    `项目：${report.project.root}`,
    `构建：${report.project.build === 'external' ? '项目自定义命令' : 'NASM'}；调试：${report.project.debug === 'c' ? 'C / GDB MI' : 'NASM / RSP'}`,
    '检查范围：工具解析与已知版本命令；不构建用户项目、不连接调试目标。',
    '',
  ];
  for (const tool of report.tools) {
    lines.push(`${tool.status === 'passed' ? '通过' : tool.status === 'failed' ? '失败' : '未执行'} · ${toolLabels[tool.id]}${tool.version ? ` ${tool.version}` : ''}`);
    lines.push(`  配置：${tool.resolution.requested}`);
    lines.push(`  路径：${tool.resolution.executable ?? '未找到'}；来源：${tool.resolution.source === 'path' ? 'PATH' : '显式配置'}`);
    lines.push(`  ${tool.reason}`);
    if (tool.status === 'failed' && tool.output) lines.push(`  输出：${tool.output.replace(/\r?\n/g, '\n  ')}`);
  }
  lines.push('', '当前基础检查没有进行协议或完整集成验证；版本可识别不等于目标功能可用。');
  lines.push(`基础检查结论：${report.status === 'passed' ? '所需工具解析/版本检查通过' : report.status === 'cancelled' ? '已取消' : '存在失败项'}`);
  if (report.runtimeReport) {
    const runtime = report.runtimeReport;
    lines.push('', `实际会话能力（独立范围）：${runtime.scope.sessionId}`);
    if (runtime.scope.targetId) lines.push(`目标：${runtime.scope.targetId}`);
    for (const entry of runtime.entries) {
      const state = entry.state === 'supported' ? '可用' : entry.state === 'unsupported' ? '不可用' : '未知';
      lines.push(`  ${entry.id}：${state}；证据：${evidenceLabels[entry.evidence]}；${entry.reason}`);
    }
  } else lines.push('当前未附加调试会话报告；RSP、段寄存器、物理内存、显示、MI 与解码能力均未由本次检查验证。');
  return lines.join('\n') + '\n';
}
