/** 使用实际 CS 隐藏 base；重置向量保持在 0xfffffff0，不会误映射成引导源码。 */
export function realModeAddress(registers: Record<string, number>): number {
  if (!Number.isInteger(registers.cs) || !Number.isInteger(registers.eip))
    throw new Error('缺少 CS/EIP 寄存器');
  validateRealModeRegisters(registers);
  return ((registers.cs_base ?? (registers.cs & 0xffff) * 16) + (registers.eip & 0xffff)) >>> 0;
}

export type CpuMode = 'real16' | 'protected16' | 'protected32';

/** CR0.PE 改变后仍使用实际 CS 缓存；远跳转加载 CS.D 后才切换到 32 位指令。 */
export function cpuMode(registers: Record<string, number>): CpuMode {
  if (registers.smm) throw new Error('当前调试不支持系统管理模式（SMM）');
  if (registers.eflags !== undefined && registers.eflags & (1 << 17))
    throw new Error('当前调试不支持虚拟 8086 模式');
  if (registers.efer !== undefined && registers.efer & (1 << 10))
    throw new Error('当前调试不支持 64 位长模式（EFER.LMA）');
  if (registers.cr0 !== undefined && registers.cr0 & 0x80000000) {
    if (!(registers.cr0 & 1)) throw new Error('分页（CR0.PG=1）要求同时开启保护模式（CR0.PE=1）');
    for (const name of ['cr3', 'cr4']) {
      const value = registers[name];
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
        throw new Error(`缺少有效的 ${name.toUpperCase()}，无法确认 32 位分页模式`);
    }
    if (registers.cr4 & (1 << 5))
      throw new Error('当前调试不支持 PAE 分页（CR4.PAE=1），仅支持 32 位非 PAE 分页');
  }
  if (!((registers.cr0 ?? 0) & 1)) {
    validateRealModeRegisters(registers);
    return 'real16';
  }
  const flags = registers.cs_flags;
  if (
    !Number.isInteger(flags) ||
    !Number.isInteger(registers.cs_base) ||
    !Number.isInteger(registers.cs_limit)
  )
    throw new Error('缺少保护模式 CS 段缓存，无法安全定位指令');
  if (flags & (1 << 21)) throw new Error('当前调试不支持 64 位代码段（CS.L）');
  // QEMU 的段缓存 flags 中，access byte 位于第 8 到 15 位。
  if ((flags & 0x9800) !== 0x9800) throw new Error('CS 必须是已存在的可执行代码段（P/S/Executable）');
  return flags & (1 << 22) ? 'protected32' : 'protected16';
}

/** 保护模式使用完整 EIP；CS.D 只决定默认操作数宽度，不限制指令地址到 64 KiB。 */
export function instructionAddress(registers: Record<string, number>): number {
  if (!Number.isInteger(registers.cs) || !Number.isInteger(registers.eip))
    throw new Error('缺少 CS/EIP 寄存器');
  const mode = cpuMode(registers);
  const offset = mode === 'real16' ? registers.eip & 0xffff : registers.eip >>> 0;
  return ((registers.cs_base ?? (registers.cs & 0xffff) * 16) + offset) >>> 0;
}

/** 栈地址宽度以 SS.B 判断，不能用 CS.D 推断刚进入保护模式时的栈宽。 */
export function stackWidth(registers: Record<string, number>): 2 | 4 {
  const mode = cpuMode(registers);
  if (mode === 'real16') return 2;
  if (!Number.isInteger(registers.ss_flags) || !Number.isInteger(registers.ss_base))
    throw new Error('缺少保护模式 SS 段缓存，无法安全定位栈');
  return registers.ss_flags & (1 << 22) ? 4 : 2;
}

/** offset 可指定 BP/ESP 链中的栈偏移，仍按当前 SS 的地址宽度回绕。 */
export function stackAddress(registers: Record<string, number>, offset = registers.esp): number {
  if (!Number.isInteger(registers.ss) || !Number.isInteger(offset)) throw new Error('缺少 SS/ESP 寄存器');
  const width = stackWidth(registers);
  const pointer = width === 4 ? offset >>> 0 : offset & 0xffff;
  return ((registers.ss_base ?? (registers.ss & 0xffff) * 16) + pointer) >>> 0;
}

export function validateRealModeRegisters(registers: Record<string, number>): void {
  if (
    (registers.cr0 !== undefined && registers.cr0 & 1) ||
    (registers.eflags !== undefined && registers.eflags & (1 << 17))
  ) {
    throw new Error('当前调试仅支持 16 位实模式；CPU 已进入保护模式或虚拟 8086 模式');
  }
  if (registers.smm) throw new Error('当前调试不支持系统管理模式（SMM）');
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
    const selector = registers[name];
    const base = registers[`${name}_base`];
    const limit = registers[`${name}_limit`];
    const flags = registers[`${name}_flags`];
    const resetCS = name === 'cs' && selector === 0xf000 && base === 0xffff0000 && registers.eip === 0xfff0;
    if (
      (base !== undefined && base !== (selector & 0xffff) * 16 && !resetCS) ||
      (limit !== undefined && limit !== 0xffff) ||
      (flags !== undefined && flags & ((1 << 22) | (1 << 21)))
    ) {
      throw new Error(
        `当前调试仅支持标准 16 位实模式；${name.toUpperCase()} 段缓存属于尚不支持的 unreal/big-real 模式`
      );
    }
  }
}
