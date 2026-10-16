import { execute, type Processes } from '../../platform/processes';
import type { Project } from '../../project/model';

/** QEMU 4.x includes an x86 column; newer releases list model names directly. */
export function qemuCpuModels(output: string): Set<string> {
  const models = new Set<string>();
  let available = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Available CPUs:\s*$/i.test(line)) {
      available = true;
      continue;
    }
    if (!available) continue;
    if (!line.trim() && models.size) break;
    const match = /^\s*(?:x86\s+)?([a-zA-Z0-9][\w.-]*)(?:\s|$)/.exec(line);
    if (match) models.add(match[1]);
  }
  return models;
}

/** No global cache: validation belongs to this launch and the actually selected tool. */
export async function validateProfileCpu(
  project: Project,
  processes: Processes,
  cancelled: () => boolean,
  timeout = 5000
): Promise<void> {
  const cpu = project.machineProfile?.settings.cpuModel;
  if (cpu === undefined) return;
  let output = '';
  let truncated = false;
  try {
    await execute(
      processes,
      project.qemu,
      ['-cpu', 'help'],
      project.root,
      (text) => {
        const remaining = 65536 - output.length;
        if (text.length > remaining) truncated = true;
        output += text.slice(0, remaining);
      },
      timeout,
      cancelled
    );
  } catch (error) {
    if (cancelled()) throw new Error('虚拟机启动已取消');
    throw new Error(`无法查询 QEMU CPU 型号：${error instanceof Error ? error.message : String(error)}`);
  }
  if (cancelled()) throw new Error('虚拟机启动已取消');
  if (truncated) throw new Error('QEMU CPU 型号输出超过 64 KiB，无法完整验证启动方案');
  const models = qemuCpuModels(output);
  if (!models.size) throw new Error('无法识别 QEMU CPU 型号列表，无法验证启动方案');
  if (!models.has(cpu))
    throw new Error(
      `启动方案 ${project.machineProfile!.name} 的 CPU 型号 ${cpu} 不在当前 QEMU 的 -cpu help 列表中`
    );
}
