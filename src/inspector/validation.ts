import type {
  DescriptorData,
  DisassemblyData,
  InspectorForm,
  InstructionBreakpoint,
  MemoryData,
  PageEntry,
  PagingData,
  WatchpointData
} from './types';
export function parseAddress(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    !/^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value.trim())
  )
    return undefined;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : undefined;
}
export function validForm(value: Partial<InspectorForm>): Partial<InspectorForm> {
  const result: Partial<InspectorForm> = {};
  if (['memory', 'gdt', 'idt', 'disassembly', 'watchpoints', 'paging'].includes(value.tab!))
    result.tab = value.tab;
  if (value.memorySpace === 'virtual' || value.memorySpace === 'physical')
    result.memorySpace = value.memorySpace;
  if (value.follow === 'address' || value.follow === 'esp' || value.follow === 'ebp')
    result.follow = value.follow;
  for (const key of ['address', 'disassemblyAddress', 'pagingAddress', 'gdtStart', 'idtStart'] as const) {
    const max =
      key === 'address' || key === 'disassemblyAddress' || key === 'pagingAddress' ? 0xffffffff : 8191;
    if (Number.isInteger(value[key]) && value[key]! >= 0 && value[key]! <= max) result[key] = value[key];
  }
  if (typeof value.disassemblyFollow === 'boolean') result.disassemblyFollow = value.disassemblyFollow;
  return result;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function memoryData(value: unknown): value is Omit<MemoryData, 'changed'> {
  return (
    object(value) &&
    Number.isInteger(value.address) &&
    (value.address as number) >= 0 &&
    (value.address as number) <= 0xffffffff &&
    Array.isArray(value.bytes) &&
    value.bytes.length <= 256 &&
    value.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) &&
    value.count === value.bytes.length &&
    (value.address as number) + value.bytes.length <= 0x100000000 &&
    typeof value.mode === 'string' &&
    ['address', 'esp', 'ebp'].includes(value.follow as string) &&
    (value.space === 'virtual' || value.space === 'physical') &&
    typeof value.addressContext === 'string' &&
    value.addressContext.length <= 128 &&
    Array.isArray(value.pageMappings) &&
    value.pageMappings.length <= 2 &&
    value.pageMappings.every(
      (mapping) =>
        object(mapping) &&
        uint32(mapping.virtualPage) &&
        uint32(mapping.physicalPage) &&
        mapping.virtualPage % 4096 === 0 &&
        mapping.physicalPage % 4096 === 0
    ) &&
    typeof value.pagingEnabled === 'boolean' &&
    (value.cr3 === undefined || uint32(value.cr3)) &&
    (value.cr4 === undefined || uint32(value.cr4))
  );
}
export function descriptorData(value: unknown, table: 'gdt' | 'idt'): value is DescriptorData {
  return (
    object(value) &&
    value.table === table &&
    typeof value.format === 'string' &&
    typeof value.mode === 'string' &&
    Number.isInteger(value.base) &&
    Number.isInteger(value.limit) &&
    Number.isInteger(value.totalEntries) &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.count) &&
    Array.isArray(value.entries) &&
    value.entries.length <= 64 &&
    value.entries.every(
      (entry) =>
        object(entry) &&
        Number.isInteger(entry.index) &&
        typeof entry.raw === 'string' &&
        typeof entry.type === 'string' &&
        Array.isArray(entry.warnings)
    ) &&
    Array.isArray(value.warnings)
  );
}

export function uint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;
}
function pageEntry(value: unknown): value is PageEntry {
  return (
    object(value) &&
    ['directory', 'table'].includes(value.level as string) &&
    Number.isInteger(value.index) &&
    (value.index as number) >= 0 &&
    (value.index as number) <= 1023 &&
    uint32(value.address) &&
    uint32(value.raw) &&
    ['present', 'writable', 'user', 'writeThrough', 'cacheDisable', 'accessed'].every(
      (key) => typeof value[key] === 'boolean'
    ) &&
    ['dirty', 'pageSize', 'global', 'pat'].every(
      (key) => value[key] === undefined || typeof value[key] === 'boolean'
    ) &&
    (value.base === undefined || uint32(value.base)) &&
    (value.reservedBits === undefined || uint32(value.reservedBits))
  );
}
export function pagingData(value: unknown): value is PagingData {
  return (
    object(value) &&
    uint32(value.address) &&
    typeof value.mode === 'string' &&
    typeof value.pagingEnabled === 'boolean' &&
    ['disabled', 'legacy32'].includes(value.format as string) &&
    uint32(value.cr0) &&
    typeof value.wp === 'boolean' &&
    typeof value.pse === 'boolean' &&
    ['cr3', 'cr4', 'directoryBase', 'physicalAddress'].every(
      (key) => value[key] === undefined || uint32(value[key])
    ) &&
    ['directoryIndex', 'tableIndex', 'offset'].every(
      (key) =>
        Number.isInteger(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= 0x3fffff
    ) &&
    ['identity', 'mapped', 'not-present', 'invalid', 'unsupported'].includes(value.status as string) &&
    (value.pageSize === undefined || value.pageSize === 4096 || value.pageSize === 4194304) &&
    (value.faultLevel === undefined || value.faultLevel === 'directory' || value.faultLevel === 'table') &&
    (value.pde === undefined || pageEntry(value.pde)) &&
    (value.pte === undefined || pageEntry(value.pte)) &&
    (value.effective === undefined ||
      (object(value.effective) &&
        ['user', 'writable', 'supervisorRead', 'supervisorWrite', 'userRead', 'userWrite'].every(
          (key) => typeof (value.effective as Record<string, unknown>)[key] === 'boolean'
        ))) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= 32 &&
    value.warnings.every((warning) => typeof warning === 'string') &&
    typeof value.explanation === 'string' &&
    (['mapped', 'identity'].includes(value.status as string)
      ? uint32(value.physicalAddress)
      : value.physicalAddress === undefined)
  );
}
export function disassemblyData(value: unknown): value is DisassemblyData {
  return (
    object(value) &&
    uint32(value.address) &&
    uint32(value.pc) &&
    typeof value.mode === 'string' &&
    (value.bits === 16 || value.bits === 32) &&
    Number.isSafeInteger(value.nextAddress) &&
    (value.nextAddress as number) >= 0 &&
    (value.nextAddress as number) <= 0x100000000 &&
    Array.isArray(value.instructions) &&
    value.instructions.length <= 256 &&
    value.instructions.every(
      (entry) =>
        object(entry) &&
        typeof entry.address === 'string' &&
        /^0x[0-9a-fA-F]{1,8}$/.test(entry.address) &&
        typeof entry.instructionBytes === 'string' &&
        /^(?:[0-9a-fA-F]{2}){0,15}$/.test(entry.instructionBytes) &&
        typeof entry.instruction === 'string' &&
        entry.instruction.length <= 256 &&
        Number.isInteger(entry.size) &&
        (entry.size as number) >= 0 &&
        (entry.size as number) <= 15 &&
        entry.instructionBytes.length === (entry.size as number) * 2 &&
        ((entry.size as number) > 0 || entry.presentationHint === 'invalid')
    )
  );
}
export function instructionBreakpoints(value: unknown): value is { breakpoints: InstructionBreakpoint[] } {
  return (
    object(value) &&
    Array.isArray(value.breakpoints) &&
    value.breakpoints.length <= 1024 &&
    value.breakpoints.every(
      (entry) =>
        object(entry) &&
        uint32(entry.address) &&
        typeof entry.verified === 'boolean' &&
        ['native', 'custom', 'both'].includes(entry.origin as string)
    )
  );
}
export function watchpointData(value: unknown): value is WatchpointData {
  return (
    object(value) &&
    Array.isArray(value.breakpoints) &&
    value.breakpoints.length <= 64 &&
    (value.warnings === undefined ||
      (Array.isArray(value.warnings) &&
        value.warnings.length <= 8 &&
        value.warnings.every((warning) => typeof warning === 'string' && warning.length <= 1024))) &&
    value.breakpoints.every(
      (entry) =>
        object(entry) &&
        Number.isSafeInteger(entry.id) &&
        typeof entry.dataId === 'string' &&
        uint32(entry.address) &&
        [1, 2, 4].includes(entry.size as number) &&
        ['write', 'read', 'readWrite'].includes(entry.access as string) &&
        typeof entry.verified === 'boolean' &&
        ['native', 'custom', 'both'].includes(entry.origin as string)
    ) &&
    (value.lastHit === undefined ||
      (object(value.lastHit) &&
        uint32(value.lastHit.address) &&
        uint32(value.lastHit.pc) &&
        ['write', 'read', 'readWrite'].includes(value.lastHit.access as string) &&
        Array.isArray(value.lastHit.ids) &&
        value.lastHit.ids.every(Number.isSafeInteger)))
  );
}

/** Coalesces reads while guarding every response with session, stop and form generations. */
