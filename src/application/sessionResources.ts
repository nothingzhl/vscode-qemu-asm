import { releaseAll } from './release';
import type { CapabilityRecorder, SessionLifecycle } from '../ports/machine';
import type { SessionOptions, SessionResources } from '../ports/session';
import type { Project } from '../project/model';

type ObservedBackend = SessionLifecycle & { readonly capabilities?: CapabilityRecorder };

/** Owns allocated and in-flight resources; release waits for late allocations too. */
export class SessionResourceOwner<Backend extends ObservedBackend> {
  get backend(): Backend | undefined {
    return this.owned?.backend;
  }
  private owned?: SessionResources<Backend>;
  private revision = 0;
  private readonly pending = new Set<Promise<SessionResources<Backend>>>();
  private readonly releasing = new WeakMap<SessionResources<Backend>, Promise<void>>();

  constructor(private readonly create: SessionOptions<Backend>['createResources']) {}

  allocate(
    project: Project,
    log: (text: string) => void,
    checkCurrent: () => void
  ): Promise<SessionResources<Backend>> {
    if (this.owned || this.pending.size) return Promise.reject(new Error('请先释放当前调试资源'));
    const revision = this.revision;
    const task = this.acquire(project, log, () => {
      if (revision !== this.revision) throw new Error('调试启动已取消');
      checkCurrent();
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }

  private async acquire(
    project: Project,
    log: (text: string) => void,
    checkCurrent: () => void
  ): Promise<SessionResources<Backend>> {
    const owner = await this.create(project, log);
    try {
      checkCurrent();
      if (owner.backend.capabilities) owner.display?.observeCapabilities?.(owner.backend.capabilities);
      this.owned = owner;
      return owner;
    } catch (error) {
      await this.releaseOnce(owner);
      throw error;
    }
  }

  async connect(): Promise<void> {
    await this.owned?.display?.connect();
  }

  async release(): Promise<void> {
    this.revision++;
    const owner = this.owned;
    this.owned = undefined;
    await Promise.all([
      owner ? this.releaseOnce(owner) : undefined,
      ...[...this.pending].map((task) => task.catch(() => undefined))
    ]);
  }

  private releaseOnce(owner: SessionResources<Backend>): Promise<void> {
    let task = this.releasing.get(owner);
    if (!task) {
      task = releaseAll([() => owner.backend.dispose(), () => owner.display?.dispose()]);
      this.releasing.set(owner, task);
    }
    return task;
  }
}
