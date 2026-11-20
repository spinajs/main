import { Autoinject, Container, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

import { AuditStore } from './contracts.js';
import type { AuditAppend, AuditReader } from './contracts.js';

const LINE = 'audit ${trail} ${kind} ${action} ${outcome} id=${id} at=${at} actor=${actor}' + '${?onBehalfOf} onBehalfOf=${onBehalfOf}${/onBehalfOf}${?subject} subject=${subject}${/subject}' + '${?traceId} trace=${traceId}${/traceId}${?origin} origin=${origin}${/origin} data=${data}';

/** One line per event on the logger `audit.<trail>` of the container that resolved the store; such a trail cannot be read back. */
@PerChildInstance()
@Injectable(AuditStore)
export class LogAuditStore extends AuditStore {
  @Autoinject(Container)
  protected Container!: IContainer;

  private readonly logs = new Map<string, Log>();

  append(write: AuditAppend): Promise<void> {
    const log = this.log(write.trail.name);
    for (const e of write.events) {
      const subject = e.subject ? `${e.subject.type}:${e.subject.id}` : undefined;
      const fields = { trail: write.trail.name, id: e.id, kind: e.kind, action: e.action, outcome: e.outcome, at: e.at.toISOString(), actor: e.actor, onBehalfOf: e.onBehalfOf, subject, traceId: e.traceId, origin: e.origin, data: JSON.stringify(e.data) };
      log[e.outcome === 'failed' || e.outcome === 'denied' ? 'warn' : 'info'](fields, LINE);
    }
    return Promise.resolve();
  }

  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(undefined);
  }

  protected log(trail: string): Pick<Log, 'info' | 'warn'> {
    let log = this.logs.get(trail);
    if (!log) {
      log = this.Container.resolve(Log, [`audit.${trail}`]);
      this.logs.set(trail, log);
    }
    return log;
  }
}
