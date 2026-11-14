import { Injectable } from '@spinajs/di';

export type FaultPointName =
  | 'outbox.after-insert'
  | 'outbox.after-publish'
  | 'outbox.before-mark'
  | 'workflow.after-step-fn'
  | 'workflow.before-journal'
  | 'workflow.after-journal'
  | 'workflow.lease-renew'
  | 'scheduler.lease-renew'
  | 'queue.before-ack'
  | 'idempotency.after-claim';

/** Named points where production code lets a test harness inject a fault (a crash, a delay); only the simulation registers a non-default implementation. */
export abstract class FaultInjector {
  public abstract point(name: FaultPointName, detail?: Record<string, unknown>): void | Promise<void>;
}

@Injectable(FaultInjector)
export class NoFaults extends FaultInjector {
  public point(): void {}
}
