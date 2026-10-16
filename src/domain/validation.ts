export function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}
