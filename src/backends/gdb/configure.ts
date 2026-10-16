import type { CapabilityRecorder } from '../../ports/machine';
import type { DebugEndpoint } from '../../ports/virtualMachine';
import type { ElfDebugConfiguration } from '../../project/model';
import type { MiClient } from './miClient';
import { miQuote } from './miParser';
import { gdbPathQuote } from './path';
/** Initialize a single MI target before the session exposes any stopped reads. */
export async function configureGdb(
  client: Pick<MiClient, 'command'>,
  debug: ElfDebugConfiguration,
  endpoint: DebugEndpoint,
  capabilities: CapabilityRecorder,
  checkCancelled: () => void
): Promise<string[]> {
  let registerNames: string[] = [];
  await client.command('-gdb-set auto-load off');
  // GDB 9 has no debuginfod feature. Probe its setting rather than treating
  // arbitrary -gdb-set errors (including a dead MI channel) as compatibility.
  let debuginfod: 'disabled' | 'unsupported' = 'disabled';
  let debuginfodReason = '当前 GDB 已明确关闭 debuginfod 联网符号查找';
  try {
    await client.command('-gdb-show debuginfod enabled');
  } catch (error) {
    if (!/^Undefined show command:\s*"debuginfod(?: enabled)?"\./.test((error as Error).message))
      throw error;
    debuginfod = 'unsupported';
    debuginfodReason = (error as Error).message;
  }
  if (debuginfod === 'disabled') await client.command('-gdb-set debuginfod enabled off');
  for (const setting of [
    'may-call-functions off',
    'pagination off',
    'confirm off',
    'mi-async on',
    'language c',
    'architecture i386',
    'trust-readonly-sections off',
    'stack-cache off',
    'code-cache off',
    'mem inaccessible-by-default off'
  ])
    await client.command(`-gdb-set ${setting}`);
  await client.command(`-file-exec-and-symbols ${miQuote(debug.elf)}`);
  capabilities.record('gdb.mi', {
    state: 'supported',
    evidence: 'protocol',
    reason: '当前 GDB MI 通道已完成初始化设置与 ELF 符号加载',
    details: { debuginfod, debuginfodReason }
  });
  for (const [before, after] of Object.entries(debug.sourceMap ?? {})) {
    await client.command(
      `-interpreter-exec console ${miQuote(`set substitute-path ${gdbPathQuote(before)} ${gdbPathQuote(after)}`)}`
    );
  }
  const deadline = Date.now() + 8000;
  while (true) {
    checkCancelled();
    try {
      await client.command(`-target-select remote ${endpoint.host}:${endpoint.port}`);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`GDB 无法连接 QEMU：${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  const names = (await client.command('-data-list-register-names')).results['register-names'];
  try {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
      throw new Error('GDB 返回无效的寄存器名称');
    registerNames = names as string[];
    for (const name of [
      'eax',
      'ecx',
      'edx',
      'ebx',
      'esp',
      'ebp',
      'esi',
      'edi',
      'eip',
      'eflags',
      'cs',
      'ss',
      'ds',
      'es',
      'fs',
      'gs'
    ]) {
      if (!registerNames.includes(name))
        throw new Error(`当前 C 调试仅支持 i386 32 位寄存器布局，缺少 ${name}`);
    }
  } catch (error) {
    capabilities.record('qemu.rspTarget', {
      state: 'unsupported',
      evidence: 'protocol',
      reason: (error as Error).message
    });
    throw error;
  }
  capabilities.record('qemu.rspTarget', {
    state: 'supported',
    evidence: 'protocol',
    reason: '当前 GDB MI 通道已连接 QEMU 并确认必需 i386 寄存器；未另建 RSP 通道或读取 target XML'
  });

  return registerNames;
}
