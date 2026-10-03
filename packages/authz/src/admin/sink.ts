import { Injectable, Singleton } from '@spinajs/di';

import { AuthzEventSink } from '../contracts/admin.js';
import type { AuthzEvent } from '../contracts/admin.js';
import { engineLog } from '../host/log.js';
import type { HostLog } from '../host/log.js';

// Values may carry user input: anything but a plain token is JSON-encoded so it cannot forge a field or a line.
const enc = (v: unknown): string => {
  const s = String(v);
  return /^[A-Za-z0-9_.:@/*-]+$/.test(s) ? s : JSON.stringify(s);
};

function format(e: AuthzEvent): string {
  let data: string;
  try {
    data = JSON.stringify(e.data) ?? 'undefined';
  } catch {
    data = '"<unserializable>"';
  }
  return `authz event ${enc(e.type)} domain=${enc(e.domain)} actor=${enc(e.actor?.type)}:${enc(e.actor?.id)} data=${data}`;
}

@Singleton()
@Injectable(AuthzEventSink)
export class LogAuthzEventSink extends AuthzEventSink {
  private log: HostLog | undefined;

  /** `log` is for tests; DI constructs the class without arguments. */
  constructor(log?: HostLog) {
    super();
    this.log = log;
  }

  async publish(events: readonly AuthzEvent[]): Promise<void> {
    for (const e of Array.isArray(events) ? events : []) {
      try {
        (this.log ??= engineLog('authz-events')).info(format(e));
      } catch {
        // logging an event never fails the committed batch
      }
    }
  }
}
