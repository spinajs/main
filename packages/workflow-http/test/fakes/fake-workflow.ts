import { WorkflowNotFound, WorkflowService, type ListFilter, type MissingVersion, type SignalOptions, type StartOptions, type WorkflowInstanceDetail, type WorkflowInstanceView } from '@spinajs/workflow';

export const INSTANCE_ID = 'wf-1';

export function makeInstance(over: Partial<WorkflowInstanceDetail> = {}): WorkflowInstanceDetail {
  return {
    id: INSTANCE_ID,
    workflow: 'order',
    version: 1,
    status: 'waiting',
    reason: null,
    input: { order: 'A-1' },
    result: null,
    error: null,
    wakeAt: null,
    waitingFor: 'approved',
    attempt: 1,
    cancelRequested: false,
    createdAt: 1,
    updatedAt: 2,
    finishedAt: null,
    steps: [{ seq: 1, key: 'wait:approved#1', kind: 'wait', status: 'pending', attempt: 1, error: null, startedAt: 1, finishedAt: null }],
    pendingEvents: [],
    ...over,
  };
}

/** Records every call; `failWith` makes the next call throw. */
export class FakeWorkflowService extends WorkflowService {
  public calls: { method: string; args: unknown[] }[] = [];
  public instances = new Map<string, WorkflowInstanceDetail>();
  public created = true;
  public accepted = true;
  public failWith: Error | undefined;

  public reset(): void {
    this.calls = [];
    this.instances = new Map([[INSTANCE_ID, makeInstance()]]);
    this.created = true;
    this.accepted = true;
    this.failWith = undefined;
  }

  public callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  protected record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failWith;
    this.failWith = undefined;
    if (failure) throw failure;
  }

  protected known(id: string): WorkflowInstanceDetail {
    const found = this.instances.get(id);
    if (!found) throw new WorkflowNotFound(id);
    return found;
  }

  public async start(workflow: unknown, input: unknown, opts?: StartOptions): Promise<{ id: string; created: boolean }> {
    this.record('start', workflow, input, opts);
    return { id: opts?.id ?? INSTANCE_ID, created: this.created };
  }

  public async signal(instanceId: string, name: string, payload: unknown, opts?: SignalOptions): Promise<{ accepted: boolean }> {
    this.record('signal', instanceId, name, payload, opts);
    this.known(instanceId);
    return { accepted: this.accepted };
  }

  public async cancel(instanceId: string, reason?: string): Promise<void> {
    this.record('cancel', instanceId, reason);
    this.known(instanceId);
  }

  public async retry(instanceId: string): Promise<void> {
    this.record('retry', instanceId);
    this.known(instanceId);
  }

  protected view(detail: WorkflowInstanceDetail): WorkflowInstanceView {
    const { steps: _steps, pendingEvents: _events, ...view } = detail;
    return view;
  }

  public async get(instanceId: string): Promise<WorkflowInstanceView | undefined> {
    this.record('get', instanceId);
    const found = this.instances.get(instanceId);
    return found && this.view(found);
  }

  public async details(instanceId: string): Promise<WorkflowInstanceDetail | undefined> {
    this.record('details', instanceId);
    return this.instances.get(instanceId);
  }

  public async list(filter: ListFilter): Promise<WorkflowInstanceView[]> {
    this.record('list', filter);
    return [...this.instances.values()].slice(0, filter.limit).map((d) => this.view(d));
  }

  public async health(): Promise<{ missingVersions: MissingVersion[] }> {
    return { missingVersions: [] };
  }
}
