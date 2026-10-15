/** monitor 补充 g 包未描述的控制寄存器与段缓存。 */
export function monitorRegisters(text: string): Record<string, number> {
  const values: Record<string, number> = {};
  const cr0 = /\bCR0=([0-9a-f]+)/i.exec(text);
  if (!cr0) throw new Error('无法读取 CR0，不能确认 CPU 执行模式');
  values.cr0 = parseInt(cr0[1], 16);
  for (const name of ['cr2', 'cr3', 'cr4', 'efer']) {
    const value = new RegExp(`\\b${name}=([0-9a-f]+)`, 'i').exec(text);
    if (value) values[name] = parseInt(value[1], 16);
  }
  const smm = /\bSMM=(\d+)/.exec(text);
  if (smm) values.smm = Number(smm[1]);
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
    const segment = new RegExp(`^${name.toUpperCase()}\\s*=([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)`, 'im').exec(text);
    if (!segment) throw new Error(`无法读取 ${name.toUpperCase()} 段缓存，不能安全定位调试地址`);
    values[name] = parseInt(segment[1], 16);
    values[`${name}_base`] = parseInt(segment[2], 16);
    values[`${name}_limit`] = parseInt(segment[3], 16);
    values[`${name}_flags`] = parseInt(segment[4], 16);
  }
  // Older monitor fixtures need not expose these; only the inspector requires them.
  for (const [name, prefix] of [['GDT', 'gdtr'], ['IDT', 'idtr']]) {
    const table = new RegExp(`^${name}\\s*=\\s*([0-9a-f]+)\\s+([0-9a-f]+)`, 'im').exec(text);
    if (table) { values[`${prefix}_base`] = parseInt(table[1], 16); values[`${prefix}_limit`] = parseInt(table[2], 16); }
  }
  for (const name of ['ldt', 'tr']) {
    const segment = new RegExp(`^${name.toUpperCase()}\\s*=\\s*([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)\\s+([0-9a-f]+)`, 'im').exec(text);
    if (!segment) continue;
    values[name] = parseInt(segment[1], 16);
    values[`${name}_base`] = parseInt(segment[2], 16);
    values[`${name}_limit`] = parseInt(segment[3], 16);
    values[`${name}_flags`] = parseInt(segment[4], 16);
  }
  return values;
}
