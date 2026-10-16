import { cpuMode, stackWidth } from './state';
export function stackRange(registers: Record<string, number>): {
  lower: number;
  upper: number;
  pointerBytes: 2 | 4;
} {
  const pointerBytes = stackWidth(registers),
    maximum = pointerBytes === 4 ? 0xffffffff : 0xffff;
  const expandDown = cpuMode(registers) !== 'real16' && !!((registers.ss_flags ?? 0) & (1 << 10));
  return {
    pointerBytes,
    lower: expandDown ? (registers.ss_limit ?? maximum) + 1 : 0,
    upper: expandDown ? maximum : Math.min(maximum, registers.ss_limit ?? maximum)
  };
}
