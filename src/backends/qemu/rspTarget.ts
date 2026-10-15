import type { RspClient } from '../rsp/client';
export async function readTarget(
  client: Pick<RspClient, 'command'>,
  annex: string,
  seen = new Set<string>()
): Promise<string> {
  if (!/^[\w.-]+$/.test(annex) || seen.has(annex) || seen.size >= 20)
    throw new Error('QEMU target XML 引用无效');
  seen.add(annex);
  let result = '';
  while (true) {
    const response = await client.command(
      `qXfer:features:read:${annex}:${Buffer.byteLength(result).toString(16)},1000`
    );
    if (!/^[ml]/.test(response)) throw new Error('QEMU 不支持 target XML，无法安全解析寄存器');
    result += response.slice(1);
    if (result.length > 1024 * 1024) throw new Error('QEMU target XML 过大');
    if (response[0] === 'l') break;
    if (response.length === 1) throw new Error('QEMU target XML 读取没有进展');
  }
  for (const match of [...result.matchAll(/<xi:include\s+href=["']([^"']+)["'][^>]*\/>/g)]) {
    result = result.replace(match[0], await readTarget(client, match[1], seen));
  }
  return result;
}
