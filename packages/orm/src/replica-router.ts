import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@spinajs/di';
import type { QueryBuilder } from './builders.js';
import type { OrmDriver } from './driver.js';
import { ConnectionState } from './resilience.js';

const WRITES = new AsyncLocalStorage<Set<OrmDriver>>();

/**
 * Runs `fn` in a read-your-writes scope: once a statement in it writes through a connection, the scope's selects on that
 * connection read its primary. An open scope is joined, not replaced. The mark lives in the scope, so a write made
 * outside any scope pins nothing.
 */
export function readYourWrites<R>(fn: () => R): R {
  return WRITES.getStore() ? fn() : WRITES.run(new Set(), fn);
}

export function markWrite(primary: OrmDriver): void {
  WRITES.getStore()?.add(primary);
}

export function wroteInScope(primary: OrmDriver): boolean {
  return WRITES.getStore()?.has(primary) === true;
}

/** Chooses the connection a model select runs on. */
export abstract class ReplicaRouter {
  public abstract register(primary: OrmDriver, replicas: OrmDriver[]): void;

  public abstract replicasOf(primary: OrmDriver): readonly OrmDriver[];

  public abstract pick(primary: OrmDriver, query: QueryBuilder): OrmDriver;
}

@Injectable(ReplicaRouter)
export class DefaultReplicaRouter extends ReplicaRouter {
  // weak: a router cached in the root container outlives the Orms that registered their drivers
  private readonly replicas = new WeakMap<OrmDriver, OrmDriver[]>();

  private readonly turns = new WeakMap<OrmDriver, number>();

  public register(primary: OrmDriver, replicas: OrmDriver[]): void {
    this.replicas.set(primary, replicas);
  }

  public replicasOf(primary: OrmDriver): readonly OrmDriver[] {
    return this.replicas.get(primary) ?? [];
  }

  /** A healthy replica, round robin, unless the read must see the primary. */
  public pick(primary: OrmDriver, _query: QueryBuilder): OrmDriver {
    const healthy = this.replicasOf(primary).filter((r) => r.State === ConnectionState.Connected);
    if (healthy.length === 0 || this.needsPrimary(primary)) {
      return primary;
    }

    const turn = this.turns.get(primary) ?? 0;
    this.turns.set(primary, turn + 1);
    return healthy.at(turn % healthy.length) ?? primary;
  }

  protected needsPrimary(primary: OrmDriver): boolean {
    const options = primary.Options;
    const sticky = (options.StickyPrimary ?? 'context') === 'context';
    return options.ReadPreference === 'primary' || primary.CurrentTransaction !== undefined || (sticky && wroteInScope(primary));
  }
}
