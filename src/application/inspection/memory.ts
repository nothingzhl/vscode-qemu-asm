import type { MemoryInspectionArgs, MemorySnapshot } from '../../domain/inspection';
import { cpuMode, instructionAddress, stackAddress } from '../../domain/x86/state';
import type { InspectionRuntime } from '../../ports/inspection';
import { walkPaging } from './paging';
import { boundedInteger, inspectionAddress, memoryRange, objectArgs, readExact } from './requests';
export async function inspectMemory(runtime: InspectionRuntime, args: unknown = {}): Promise<MemorySnapshot> {
  objectArgs(args);
  const request = args as MemoryInspectionArgs;
  const follow = request.follow === undefined ? 'address' : request.follow;
  if (!['address', 'esp', 'ebp'].includes(follow)) throw new Error('内存跟随方式必须是 address、esp 或 ebp');
  const space = request.space === undefined ? 'virtual' : request.space;
  if (space !== 'virtual' && space !== 'physical') throw new Error('内存地址空间必须是 virtual 或 physical');
  if (space === 'physical' && follow !== 'address')
    throw new Error(
      '物理内存模式仅接受显式物理地址；请切换地址模式，不能直接把 ESP/EBP 线性地址当作物理地址'
    );
  const count = boundedInteger(request.count === undefined ? 256 : request.count, 1, 4096, '内存读取长度');
  // Validate even an unused address so malformed messages cannot change meaning silently.
  const requested = request.address === undefined ? undefined : inspectionAddress(request.address);
  if (space === 'physical' && requested === undefined) throw new Error('物理内存模式需要显式物理地址');
  const registers = await runtime.registers();
  const mode = cpuMode(registers);
  const address =
    follow === 'esp'
      ? stackAddress(registers)
      : follow === 'ebp'
        ? stackAddress(registers, registers.ebp)
        : (requested ?? instructionAddress(registers));
  memoryRange(address, count);
  const bytes = await readExact(runtime, address, count, space);
  const pagingEnabled = !!((registers.cr0 ?? 0) & 0x80000000);
  let addressContext = space === 'physical' ? 'physical' : 'virtual:unpaged';
  const pageMappings: MemorySnapshot['pageMappings'] = [];
  if (space === 'virtual' && pagingEnabled) {
    // Including each touched 4 KiB backing page avoids calling a page remap a
    // byte change when guest code rewrites a PTE without changing CR3.
    const physicalRuntime = {
      readPhysicalMemory: (location: number, length: number) =>
        readExact(runtime, location, length, 'physical')
    };
    for (let page = Math.floor(address / 4096) * 4096; page < address + count; page += 4096) {
      const mapping = await walkPaging(physicalRuntime, registers, page);
      if (mapping.physicalAddress === undefined)
        throw new Error(`无法确定虚拟内存的物理映射：${mapping.explanation}`);
      pageMappings.push({ virtualPage: page, physicalPage: mapping.physicalAddress });
    }
    addressContext = `virtual:legacy32:${registers.cr3}:${registers.cr4}`;
  }
  return {
    address,
    count,
    bytes: [...bytes],
    mode,
    follow,
    space,
    pagingEnabled,
    cr3: registers.cr3,
    cr4: registers.cr4,
    addressContext,
    pageMappings,
    registers: { esp: registers.esp, ebp: registers.ebp, ss: registers.ss, ss_base: registers.ss_base }
  };
}
