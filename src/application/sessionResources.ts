import { releaseAll } from './release';
import type { CapabilityRecorder, SessionLifecycle } from '../ports/machine';
import type { SessionOptions, SessionResources } from '../ports/session';
import type { Project } from '../project/model';

type ObservedBackend = SessionLifecycle & { readonly capabilities?: CapabilityRecorder };
interface AllocationOutcome {
  cleanupFailure?: { reason: unknown };
}

/** Owns allocated and in-flight resources; release waits for late allocations too. */
export class SessionResourceOwner<Backend extends ObservedBackend> {
  get backend(): Backend | undefined {
    return this.owned?.backend;
  }
  private owned?: SessionResources<Backend>;
  private revision = 0;
  private readonly pending = new Map<Promise<SessionResources<Backend>>, AllocationOutcome>();
  private readonly releasing = new WeakMap<SessionResources<Backend>, Promise<void>>();
  private readonly cleanup = new Set<Promise<void>>();
  private releaseTask?: Promise<void>;

  constructor(private readonly create: SessionOptions<Backend>['createResources']) {}

  allocate(
    project: Project,
    log: (text: string) => void,
    checkCurrent: () => void
  ): Promise<SessionResources<Backend>> {
    if (this.owned || this.pending.size || this.cleanup.size || this.releaseTask)
      return Promise.reject(new Error('请先释放当前调试资源'));
    const revision = this.revision;
    const outcome: AllocationOutcome = {};
    const task = Promise.resolve().then(() =>
      this.acquire(
        project,
        log,
        () => {
          if (revision !== this.revision) throw new Error('调试启动已取消');
          checkCurrent();
        },
        outcome
      )
    );
    this.pending.set(task, outcome);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }

  private async acquire(
    project: Project,
    log: (text: string) => void,
    checkCurrent: () => void,
    outcome: AllocationOutcome
  ): Promise<SessionResources<Backend>> {
    const owner = await this.create(project, log);
    try {
      checkCurrent();
      if (owner.backend.capabilities) owner.display?.observeCapabilities?.(owner.backend.capabilities);
      checkCurrent();
      this.owned = owner;
      return owner;
    } catch (error) {
      try {
        await this.releaseOnce(owner);
      } catch (cleanupError) {
        outcome.cleanupFailure = { reason: cleanupError };
        throw cleanupError;
      }
      throw error;
    }
  }

  async connect(): Promise<void> {
    await this.owned?.display?.connect();
  }

  release(): Promise<void> {
    if (this.releaseTask) return this.releaseTask;
    this.revision++;
    const owner = this.owned;
    this.owned = undefined;
    if (owner) this.releaseOnce(owner);
    const task = releaseAll([
      ...[...this.cleanup].map((task) => () => task),
      ...[...this.pending].map(([allocation, outcome]) => async () => {
        await allocation.catch(() => undefined);
        if (outcome.cleanupFailure) throw outcome.cleanupFailure.reason;
      })
    ]);
    this.releaseTask = task;
    void task
      .finally(() => {
        if (this.releaseTask === task) this.releaseTask = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  private releaseOnce(owner: SessionResources<Backend>): Promise<void> {
    let task = this.releasing.get(owner);
    if (!task) {
      task = releaseAll([() => owner.backend.dispose(), () => owner.display?.dispose()]);
      this.releasing.set(owner, task);
      this.cleanup.add(task);
      void task.finally(() => this.cleanup.delete(task!)).catch(() => undefined);
    }
    return task;
  }
}
