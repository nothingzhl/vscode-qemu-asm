export interface RegisterLayout {
  name: string;
  bits: number;
  offset: number;
  number: number;
}

/** 按 target XML 中的 regnum/位宽计算 g 数据包的字节偏移。 */
export function registerLayout(xml: string): RegisterLayout[] {
  const registers: RegisterLayout[] = [];
  let number = 0;
  let offset = 0;
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<reg\s+([^>]+)\/?\s*>/g)) {
    const attributes = new Map(
      [...match[1].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((value) => [value[1], value[2]])
    );
    const name = attributes.get('name');
    const bits = Number(attributes.get('bitsize'));
    const explicit = attributes.get('regnum');
    if (explicit !== undefined) number = Number(explicit);
    if (
      !name ||
      !Number.isSafeInteger(bits) ||
      bits <= 0 ||
      bits % 8 ||
      !Number.isSafeInteger(number) ||
      number < 0
    )
      throw new Error('QEMU 返回无效的寄存器描述');
    if (registers.length && number !== registers[registers.length - 1].number + 1)
      throw new Error('QEMU 寄存器编号不连续，无法安全解析');
    registers.push({ name, bits, offset, number });
    offset += bits / 8;
    number++;
  }
  return registers;
}

export function decodeRegisters(hex: string, layout: RegisterLayout[]): Record<string, number> {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('QEMU 返回无效的寄存器数据');
  const bytes = Buffer.from(hex, 'hex');
  const registers: Record<string, number> = {};
  for (const register of layout) {
    if (register.offset + register.bits / 8 > bytes.length) throw new Error('QEMU 寄存器数据长度不足');
    if (register.bits <= 32) registers[register.name] = bytes.readUIntLE(register.offset, register.bits / 8);
  }
  return registers;
}
