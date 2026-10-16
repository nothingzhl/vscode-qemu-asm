import { cpuMode, instructionAddress } from '../../domain/x86/state';

import type { PagingEntry, PagingPermissions, PagingSnapshot } from '../../domain/paging';
import type { PagingRuntime } from '../../ports/inspection';
export async function inspectPaging(runtime: PagingRuntime, args: unknown = {}): Promise<PagingSnapshot> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('分页检查参数必须是对象');
  const value = (args as { address?: unknown }).address;
  const requested = value === undefined ? undefined : pagingAddress(value);
  const registers = await runtime.registers();
  // This also rejects PAE, long mode, SMM and invalid PE/PG combinations.
  cpuMode(registers);
  return walkPaging(runtime, registers, requested ?? instructionAddress(registers));
}

/** Reuse one paused register snapshot when inspecting several adjacent memory pages. */
export async function walkPaging(
  runtime: Pick<PagingRuntime, 'readPhysicalMemory'>,
  registers: Record<string, number>,
  address: number
): Promise<PagingSnapshot> {
  address = pagingAddress(address);
  const mode = cpuMode(registers);
  const cr0 = register32(registers.cr0, 'CR0');
  const pagingEnabled = !!(cr0 & 0x80000000);
  const cr3 = optionalRegister32(registers.cr3, 'CR3');
  const cr4 = optionalRegister32(registers.cr4, 'CR4');
  const snapshot: PagingSnapshot = {
    address,
    mode,
    pagingEnabled,
    format: pagingEnabled ? 'legacy32' : 'disabled',
    cr0,
    cr3,
    cr4,
    wp: !!(cr0 & 0x10000),
    pse: !!((cr4 ?? 0) & 0x10),
    directoryIndex: address >>> 22,
    tableIndex: (address >>> 12) & 1023,
    offset: address & 4095,
    status: 'identity',
    warnings: [],
    explanation: 'CR0.PG=0：未进行分页转换，线性地址等于物理地址；段转换与物理设备映射仍独立生效。'
  };
  if (!pagingEnabled) {
    snapshot.physicalAddress = address;
    return snapshot;
  }
  // cpuMode already required both CR3 and CR4 for paging. Keep this guard local
  // so the physical walker cannot silently reinterpret a partial CPU snapshot.
  if (cr3 === undefined || cr4 === undefined) throw new Error('分页检查缺少 CR3/CR4');
  snapshot.directoryBase = (cr3 & 0xfffff000) >>> 0;
  snapshot.status = 'not-present';
  snapshot.warnings.push(
    '此视图读取当前页表内存，不读取 CPU 的 TLB；修改页表后可能需要 INVLPG 或重新加载 CR3，CPU 缓存的转换才会更新。'
  );
  if (cr4 & ((1 << 20) | (1 << 21)))
    snapshot.warnings.push(
      '当前启用了 SMEP/SMAP；以下结果仅解释页表 R/W、U/S 与 CR0.WP，不计算其额外访问限制。'
    );
  const directoryAddress = snapshot.directoryBase + snapshot.directoryIndex * 4;
  const pde = await readEntry(runtime, 'directory', directoryAddress, snapshot.directoryIndex);
  snapshot.pde = pde;
  // Present=0 makes all remaining fields available to software. Do not report
  // their arbitrary values as reserved-bit faults or manufacture a physical page.
  if (!pde.present)
    return fault(snapshot, 'directory', 'not-present', '页目录项 P=0：此线性地址未映射，不继续读取页表。');
  if (pde.pageSize && snapshot.pse) {
    snapshot.offset = address & 0x3fffff;
    pde.dirty = !!(pde.raw & 0x40);
    pde.global = !!(pde.raw & 0x100);
    pde.pat = !!(pde.raw & 0x1000);
    if (pde.raw & 0x200000) {
      pde.reservedBits = pde.raw & 0x200000;
      return fault(snapshot, 'directory', 'invalid', '4 MiB 页目录项的保留位 21 为 1；该页表项无效。');
    }
    // PSE-36 places physical bits above bit 31 in PDE[20:13]. The runtime's
    // physical address API is deliberately 32-bit, so never mask them away.
    if (pde.raw & 0x1fe000)
      return fault(
        snapshot,
        'directory',
        'unsupported',
        '此 4 MiB 页使用 PDE[20:13] 的 PSE-36 高物理地址；当前仅支持 32 位物理地址，未截断为错误地址。'
      );
    pde.base = (pde.raw & 0xffc00000) >>> 0;
    snapshot.pageSize = 4194304;
    snapshot.physicalAddress = pde.base + snapshot.offset;
    snapshot.effective = permissions(pde.user, pde.writable, snapshot.wp);
  } else {
    // Intel legacy paging ignores PDE.PS when CR4.PSE=0; it still points to a
    // 4 KiB page table. Expose the flag and explain why it is not a large page.
    if (pde.pageSize) snapshot.warnings.push('PDE.PS=1 但 CR4.PSE=0；PS 被忽略，按普通 4 KiB 页表解释。');
    pde.base = (pde.raw & 0xfffff000) >>> 0;
    const tableAddress = pde.base + snapshot.tableIndex * 4;
    const pte = await readEntry(runtime, 'table', tableAddress, snapshot.tableIndex);
    snapshot.pte = pte;
    if (!pte.present)
      return fault(snapshot, 'table', 'not-present', '页表项 P=0：此线性地址未映射，不生成物理地址。');
    pte.base = (pte.raw & 0xfffff000) >>> 0;
    snapshot.pageSize = 4096;
    snapshot.physicalAddress = pte.base + snapshot.offset;
    snapshot.effective = permissions(pde.user && pte.user, pde.writable && pte.writable, snapshot.wp);
  }
  snapshot.status = 'mapped';
  const effective = snapshot.effective;
  snapshot.explanation = `${snapshot.pageSize === 4194304 ? '4 MiB 大页' : '4 KiB 页'}转换完成。页级权限：${effective.user ? '允许用户态读取' : '仅监督态'}，R/W=${effective.writable ? 1 : 0}；CR0.WP=${snapshot.wp ? 1 : 0}，监督态${effective.supervisorWrite ? '可写' : '不可写'}。非 PAE 页表没有 NX 位；此结果不代替段权限、CPL 或其他 CPU 保护检查。`;
  return snapshot;
}

function fault(
  snapshot: PagingSnapshot,
  level: 'directory' | 'table',
  status: 'not-present' | 'invalid' | 'unsupported',
  explanation: string
): PagingSnapshot {
  snapshot.status = status;
  snapshot.faultLevel = level;
  snapshot.explanation = explanation;
  return snapshot;
}

function permissions(user: boolean, writable: boolean, wp: boolean): PagingPermissions {
  return {
    user,
    writable,
    supervisorRead: true,
    supervisorWrite: writable || !wp,
    userRead: user,
    userWrite: user && writable
  };
}

async function readEntry(
  runtime: Pick<PagingRuntime, 'readPhysicalMemory'>,
  level: 'directory' | 'table',
  address: number,
  index: number
): Promise<PagingEntry> {
  if (typeof runtime.readPhysicalMemory !== 'function')
    throw new Error('当前调试运行时不支持物理内存读取，无法检查页表');
  const bytes = await runtime.readPhysicalMemory(address, 4);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 4)
    throw new Error('运行时返回的页表项不完整，必须恰好包含 4 字节');
  const raw = bytes.readUInt32LE(0);
  const entry: PagingEntry = {
    level,
    index,
    address,
    raw,
    present: !!(raw & 1),
    writable: !!(raw & 2),
    user: !!(raw & 4),
    writeThrough: !!(raw & 8),
    cacheDisable: !!(raw & 16),
    accessed: !!(raw & 32)
  };
  if (level === 'directory') entry.pageSize = !!(raw & 0x80);
  else {
    entry.dirty = !!(raw & 0x40);
    entry.global = !!(raw & 0x100);
    entry.pat = !!(raw & 0x80);
  }
  return entry;
}

function pagingAddress(value: unknown): number {
  let address = value;
  if (typeof value === 'string' && /^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(value.trim()))
    address = Number(value.trim());
  if (typeof address !== 'number' || !Number.isSafeInteger(address) || address < 0 || address > 0xffffffff)
    throw new Error('线性地址必须是十进制或 0x 开头的 32 位地址');
  return address;
}

function register32(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || value! < 0 || value! > 0xffffffff)
    throw new Error(`分页检查缺少有效的 ${name}`);
  return value!;
}

function optionalRegister32(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : register32(value, name);
}
