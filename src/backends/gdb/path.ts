/** GDB CLI 的路径参数只做引号/反斜杠转义，不能使用 MI 的八进制字符串编码。 */
export function gdbPathQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('源码路径映射不支持换行或控制字符');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
