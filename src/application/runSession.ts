import { releaseAll } from './release';
import type { DebugDisplay } from '../ports/presentation';
import type { MachineRun, VirtualMachine } from '../ports/virtualMachine';

interface Resources {
  machine: VirtualMachine;
  display?: DebugDisplay;
}

/** Owns a run-only machine, pending allocation and optional display until cleanup completes. */
export class RunSession {
  private generation = 0;
  private current?: Resources;
  private pending?: Promise<MachineRun>;
  private readonly releasing = new WeakMap<Resources, Promise<void>>();

  start(create: () => Promise<Resources>): Promise<MachineRun> {
    if (this.pending || this.current) return Promise.reject(new Error('请先停止当前运行'));
    const task = this.launch(create, this.generation);
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  private async launch(create: () => Promise<Resources>, token: number): Promise<MachineRun> {
    const owner = await create();
    try {
      if (token !== this.generation) throw new Error('运行启动已取消');
      this.current = owner;
      const run = await owner.machine.start();
      if (token !== this.generation) throw new Error('运行启动已取消');
      void run.exited
        .then(
          () => this.release(owner),
          () => this.release(owner)
        )
        .catch(() => undefined);
      await owner.display?.connect();
      if (token !== this.generation) throw new Error('运行启动已取消');
      return run;
    } catch (error) {
      await this.release(owner);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    const pending = this.pending;
    const owner = this.current;
    if (owner) await this.release(owner);
    // Pending allocation may still produce a resource after stop. launch owns
    // that resource and releases it before its cancelled promise settles.
    await pending?.catch(() => undefined);
  }

  private release(owner: Resources): Promise<void> {
    let task = this.releasing.get(owner);
    if (!task) {
      task = releaseAll([() => owner.machine.dispose(), () => owner.display?.dispose()]);
      this.releasing.set(owner, task);
      void task
        .finally(() => {
          if (this.current === owner) this.current = undefined;
        })
        .catch(() => undefined);
    }
    return task;
  }
}
