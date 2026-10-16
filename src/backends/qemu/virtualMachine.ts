import { freePort } from '../../platform/ports';
import { Processes } from '../../platform/processes';
import type { MachineRun, MachineStartOptions, VirtualMachine } from '../../ports/virtualMachine';
import type { Project } from '../../project/model';
import {
  formatQemuLaunchConfiguration,
  qemuArguments,
  qemuLaunchConfiguration,
  qemuMachineArguments
} from './arguments';
import { validateProfileCpu } from './cpuModels';

/** QEMU command-line syntax and process ownership stop at this boundary. */
export class QemuVirtualMachine implements VirtualMachine {
  private started = false;
  private disposed = false;

  constructor(
    private readonly project: Project,
    private readonly processes: Processes,
    private readonly log: (text: string) => void,
    private readonly attachments: readonly string[] = []
  ) {}

  async start(options: MachineStartOptions = {}): Promise<MachineRun> {
    if (this.started || this.disposed) throw new Error('虚拟机不能重复启动或在释放后启动');
    this.started = true;
    this.log(formatQemuLaunchConfiguration(qemuLaunchConfiguration(this.project)) + '\n');
    if (options.debug) {
      const machineArgs = qemuMachineArguments(this.project);
      for (let index = 0; index < machineArgs.length; index += 2) {
        if (machineArgs[index] === '-smp' && machineArgs[index + 1] !== '1') {
          throw new Error('当前调试仅支持单 CPU，请把 -smp 设置为 1');
        }
      }
    }
    await validateProfileCpu(this.project, this.processes, () => this.disposed);
    const endpoint = options.debug ? { host: '127.0.0.1', port: await freePort() } : undefined;
    if (this.disposed) throw new Error('虚拟机启动已取消');
    const args = [...qemuArguments(this.project), ...this.attachments];
    if (options.paused) args.push('-S');
    if (endpoint) args.push('-gdb', `tcp:${endpoint.host}:${endpoint.port}`);
    const run = this.processes.start(this.project.qemu, args, this.project.root, this.log);
    await run.ready;
    if (this.disposed) {
      await this.processes.dispose();
      throw new Error('虚拟机启动已取消');
    }
    return { debugEndpoint: endpoint, executable: run.tool.executable!, exited: run.done };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.processes.dispose();
  }
}
