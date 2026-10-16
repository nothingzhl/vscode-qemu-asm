export function decodePayload(encoded: Buffer): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const byte = encoded[i];
    if (byte === 125) {
      if (++i >= encoded.length) throw new Error('QEMU 返回不完整的 RSP 转义');
      bytes.push(encoded[i] ^ 32);
    } else if (byte === 42) {
      if (!bytes.length || ++i >= encoded.length || encoded[i] < 29)
        throw new Error('QEMU 返回无效的 RSP 重复编码');
      const previous = bytes[bytes.length - 1];
      for (let count = encoded[i] - 29; count > 0; count--) bytes.push(previous);
    } else bytes.push(byte);
  }
  return Buffer.from(bytes).toString('latin1');
}
