import { Injectable, Singleton } from '@spinajs/di';

import { AuthzEventSink } from '../contracts/admin.js';
import type { AuthzEvent } from '../contracts/admin.js';
import { engineLog } from '../host/log.js';
import type { AuthzLog } from '../host/log.js';

// The Log escapes and quotes each value, so user input in one cannot forge a field or a line.
const LINE = 'authz event ${type} domain=${domain} actor=${actorType}:${actorId}${?data} data=${data}${/data}';

const fields = (e: AuthzEvent): Record<string, unknown> => ({ type: e.type, domain: e.domain, actorType: e.actor?.type, actorId: e.actor?.id, data: e.data });

@Singleton()
@Injectable(AuthzEventSink)
export class LogAuthzEventSink extends AuthzEventSink {
  private log: Pick<AuthzLog, 'info'> | undefined;

  /** `log` is for tests; DI constructs the class without arguments. */
  constructor(log?: Pick<AuthzLog, 'info'>) {
    super();
    this.log = log;
  }

  async publish(events: readonly AuthzEvent[]): Promise<void> {
    for (const e of Array.isArray(events) ? events : []) {
      try {
        (this.log ??= engineLog('authz-events')).info(fields(e), LINE);
      } catch {
        // logging an event never fails the committed batch
      }
    }
  }
}
