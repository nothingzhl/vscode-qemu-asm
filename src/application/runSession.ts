import { releaseAll } from './release';
import type { DebugDisplay } from '../ports/presentation';
import type { MachineRun, VirtualMachine } from '../ports/virtualMachine';

interface Resources {
  machine: VirtualMachine;
  display?: DebugDisplay;
}
interface LaunchOutcome {
  cleanupFailure?: { reason: unknown };
}

/** Owns a run-only machine, pending allocation and optional display until cleanup completes. */
export class RunSession {
  private generation = 0;
  private current?: Resources;
  private pending?: { task: Promise<MachineRun>; outcome: LaunchOutcome };
  private stopping?: Promise<void>;
  private readonly releasing = new WeakMap<Resources, Promise<void>>();

  start(create: () => Promise<Resources>): Promise<MachineRun> {
    if (this.pending || this.current || this.stopping) return Promise.reject(new Error('请先停止当前运行'));
    const generation = this.generation;
    const outcome: LaunchOutcome = {};
    const task = Promise.resolve().then(() => this.launch(create, generation, outcome));
    this.pending = { task, outcome };
    void task
      .finally(() => {
        if (this.pending?.task === task) this.pending = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  private async launch(
    create: () => Promise<Resources>,
    token: number,
    outcome: LaunchOutcome
  ): Promise<MachineRun> {
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
      try {
        await this.release(owner);
      } catch (cleanupError) {
        outcome.cleanupFailure = { reason: cleanupError };
        throw cleanupError;
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.generation++;
    const pending = this.pending;
    const owner = this.current;
    // Pending allocation may still produce a resource after stop. launch owns
    // that resource and releases it before its cancelled promise settles.
    const task = releaseAll([
      () => (owner ? this.release(owner) : undefined),
      async () => {
        await pending?.task.catch(() => undefined);
        if (pending?.outcome.cleanupFailure) throw pending.outcome.cleanupFailure.reason;
      }
    ]);
    this.stopping = task;
    void task
      .finally(() => {
        if (this.stopping === task) this.stopping = undefined;
      })
      .catch(() => undefined);
    return task;
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
