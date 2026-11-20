import { AuthnEventListener } from '@spinajs/authn/contracts';
import type { AuthnEvent, AuthnEventType } from '@spinajs/authn/contracts';
import type { EventsPort } from '../harness/ports.js';

export class RecordingEventListener extends AuthnEventListener implements EventsPort {
  private events: AuthnEvent[] = [];

  async on(e: AuthnEvent): Promise<void> {
    this.events.push(Object.freeze({ ...e }));
  }

  all(): readonly AuthnEvent[] {
    return [...this.events];
  }

  ofType(t: AuthnEventType): readonly AuthnEvent[] {
    return this.events.filter((e) => e.type === t);
  }

  clear(): void {
    this.events = [];
  }
}
