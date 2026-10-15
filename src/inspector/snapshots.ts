import type { InspectorForm, InspectorSession, InspectorSnapshot } from './types';
import {
  descriptorData,
  disassemblyData,
  instructionBreakpoints,
  memoryData,
  pagingData,
  watchpointData
} from './validation';
export interface RawInspectorSnapshot {
  value: unknown;
  instructionState?: unknown;
}
export async function readInspectorSnapshot(
  session: InspectorSession,
  form: InspectorForm
): Promise<RawInspectorSnapshot> {
  let value: unknown;
  let instructionState: unknown;
  if (form.tab === 'memory')
    value = await session.customRequest('qemuAsm.inspectMemory', {
      address: form.address,
      count: form.follow === 'address' ? Math.min(256, 0x100000000 - form.address) : 256,
      follow: form.follow,
      space: form.memorySpace
    });
  else if (form.tab === 'paging')
    value = await session.customRequest('qemuAsm.inspectPaging', { address: form.pagingAddress });
  else if (form.tab === 'gdt' || form.tab === 'idt')
    value = await session.customRequest('qemuAsm.inspectDescriptors', {
      table: form.tab,
      start: form.tab === 'gdt' ? form.gdtStart : form.idtStart,
      count: 64
    });
  else if (form.tab === 'disassembly')
    [value, instructionState] = await Promise.all([
      session.customRequest('qemuAsm.disassemble', {
        ...(form.disassemblyFollow ? {} : { address: form.disassemblyAddress }),
        count: 64
      }),
      session.customRequest('qemuAsm.instructionBreakpoints', { action: 'list' })
    ]);
  else value = await session.customRequest('qemuAsm.watchpoints', { action: 'list' });

  return { value, instructionState };
}
/** Commits history only after the model has confirmed that the response is current. */
export class InspectorSnapshots {
  private readonly seen = new Map<string, number>();
  clear(): void {
    this.seen.clear();
  }
  apply(form: InspectorForm, raw: RawInspectorSnapshot): Partial<InspectorSnapshot> {
    const { value, instructionState } = raw;
    if (form.tab === 'memory') {
      if (!memoryData(value)) throw new Error('调试器返回了无效的内存快照');
      if (value.space !== form.memorySpace || (value.space === 'physical' && value.follow !== 'address'))
        throw new Error('调试器返回的内存地址空间不匹配');
      const mappings = value.pageMappings;
      if (
        value.space === 'virtual' &&
        value.pagingEnabled &&
        value.bytes.some(
          (_, offset) =>
            !mappings.some(
              (mapping) => mapping.virtualPage === Math.floor((value.address + offset) / 4096) * 4096
            )
        )
      )
        throw new Error('调试器返回的分页内存快照缺少物理映射');
      const key = (offset: number) => {
        const address = value.address + offset;
        const physicalPage =
          value.space === 'virtual' && value.pagingEnabled
            ? mappings.find((mapping) => mapping.virtualPage === Math.floor(address / 4096) * 4096)
                ?.physicalPage
            : '';
        return `${value.space}:${value.addressContext}:${physicalPage}:${address}`;
      };
      const changed = value.bytes.map(
        (byte, index) => this.seen.has(key(index)) && this.seen.get(key(index)) !== byte
      );
      for (let index = 0; index < value.bytes.length; index += 1)
        this.seen.set(key(index), value.bytes[index]);
      while (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
      return {
        memory: { ...value, changed },
        stale: false,
        busy: false,
        message: `已暂停 · ${value.mode} · ${value.space === 'physical' ? '物理' : '虚拟'}内存 · ${value.bytes.length} 字节`
      };
    } else if (form.tab === 'paging') {
      if (!pagingData(value)) throw new Error('调试器返回了无效的页表快照');
      return {
        paging: value,
        stale: false,
        busy: false,
        message: `已暂停 · ${value.mode} · ${value.pagingEnabled ? '32 位分页' : '分页未开启'}`
      };
    } else if (form.tab === 'disassembly') {
      if (!disassemblyData(value) || !instructionBreakpoints(instructionState))
        throw new Error('调试器返回了无效的反汇编快照');
      return {
        disassembly: value,
        instructionBreakpoints: instructionState.breakpoints,
        stale: false,
        busy: false,
        message: `已暂停 · ${value.mode} · ${value.bits} 位 · ${value.instructions.length} 条指令`
      };
    } else if (form.tab === 'watchpoints') {
      if (!watchpointData(value)) throw new Error('调试器返回了无效的数据断点快照');
      return {
        watchpoints: value,
        stale: false,
        busy: false,
        message: `已暂停 · ${value.breakpoints.length} 个数据断点${value.lastHit ? ' · 已命中数据断点' : ''}`
      };
    } else {
      if (!descriptorData(value, form.tab)) throw new Error('调试器返回了无效的描述符表快照');
      return {
        [form.tab]: value,
        stale: false,
        busy: false,
        message: `已暂停 · ${value.mode} · ${value.totalEntries} 项`
      };
    }
  }
}
