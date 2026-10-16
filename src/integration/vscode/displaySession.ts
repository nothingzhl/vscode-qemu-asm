import type { QemuDisplay } from '../../composition/options';
import type { DisplayController } from '../../display/controller';
import type { CapabilityRecorder } from '../../ports/machine';

/** The host integration binds QEMU presentation details; application sessions only see DebugDisplay. */
export async function createDisplaySession(
  controller: DisplayController,
  enabled: boolean
): Promise<QemuDisplay | undefined> {
  const screen = await controller.createOptional({ enabled });
  if (!screen) return undefined;
  return {
    args: screen.args,
    observeCapabilities: (ledger: CapabilityRecorder) => {
      screen.on('status', (status: { state: string; message?: string }) => {
        if (status.state === 'connected')
          ledger.record('qemu.display', {
            state: 'unknown',
            evidence: 'protocol',
            reason: 'QMP 协商成功；实际截图及共享文件路径尚未验证'
          });
        else if (status.state === 'error')
          ledger.record('qemu.display', {
            state: 'unsupported',
            evidence: 'protocol',
            reason: status.message ?? '当前显示连接或截图失败'
          });
      });
      screen.on('frame', (frame: { width: number; height: number }) =>
        ledger.record('qemu.display', {
          state: 'supported',
          evidence: 'integration',
          reason: '已读取当前 QEMU 的截图并转换为显示画面',
          details: { width: frame.width, height: frame.height }
        })
      );
    },
    connect: () => controller.connect(screen),
    dispose: () => controller.stop(screen)
  };
}
