import type { StoppedEvent, WatchAccess } from '../../ports/machine';
/** 监视点字段优先于单步/暂停意图，避免把真实内存访问误当成内部停止吞掉。 */
export function stoppedEvent(packet: string, expected: StoppedEvent['reason']): StoppedEvent {
  const signal = parseInt(packet.slice(1, 3), 16);
  const match = /(?:^T[0-9a-f]{2}|;)(watch|rwatch|awatch):([0-9a-f]+);/i.exec(packet);
  if (match) {
    const address = parseInt(match[2], 16);
    if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff)
      throw new Error('QEMU 返回无效的数据断点地址');
    const access: Record<string, WatchAccess> = { watch: 'write', rwatch: 'read', awatch: 'readWrite' };
    return {
      reason: 'data breakpoint',
      signal,
      dataAddress: address,
      dataAccess: access[match[1].toLowerCase()]
    };
  }
  return { reason: signal === 5 ? expected : signal === 2 ? 'pause' : 'exception', signal };
}
