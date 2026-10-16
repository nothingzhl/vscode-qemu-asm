export const hex = (value: number, digits = 8) =>
  `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`;
export const integer = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
export const readOnly = { attributes: ['readOnly'] };
