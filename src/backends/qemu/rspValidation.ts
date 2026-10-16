export function validateAddress(address: number): void {
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff)
    throw new Error('调试地址必须是有效的 32 位无符号整数');
}
export function expectOK(response: string, operation: string): void {
  if (response !== 'OK') throw new Error(`QEMU 不支持${operation}：${response || '空回复'}`);
}
