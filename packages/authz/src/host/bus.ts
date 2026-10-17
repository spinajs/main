import { Injectable, Singleton } from '@spinajs/di';
import { ListenerSet } from '@spinajs/util';
import { ChangeBus } from '../contracts/service.js';
import type { AuthzChange } from '../contracts/service.js';
import { engineLog, thrownError } from './log.js';

@Singleton()
@Injectable(ChangeBus)
export class InProcessChangeBus extends ChangeBus {
  private readonly log = engineLog('authz-bus');
  private readonly subscribers = new ListenerSet<AuthzChange>((err) => this.log.error({ error: thrownError(err) }, 'authz change subscriber failed'));

  async publish(change: AuthzChange): Promise<void> {
    this.subscribers.emit(change);
  }

  subscribe(fn: (c: AuthzChange) => void): () => void {
    return this.subscribers.add(fn);
  }
}
