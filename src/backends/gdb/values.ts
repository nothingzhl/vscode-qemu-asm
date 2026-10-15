import type { MiTuple, MiValue } from './miParser';
export const tuple = (value: MiValue | undefined): MiTuple =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const text = (value: MiValue | undefined, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
export function records(value: MiValue | undefined, wrapper?: string): MiTuple[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = tuple(item);
    return wrapper && row[wrapper] ? [tuple(row[wrapper])] : Object.keys(row).length ? [row] : [];
  });
}
export function address(value: MiValue | undefined): number | undefined {
  const match = /^(0x[\da-f]+)(?:\s|$)/i.exec(text(value));
  const result = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(result) && result >= 0 && result <= 0xffffffff ? result : undefined;
}
