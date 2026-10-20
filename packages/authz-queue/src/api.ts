import type { Ceiling, PrincipalType } from '@spinajs/authz';

export { QueueMessageHook } from '@spinajs/queue';
// no runAs ⇒ the handler runs as UNATTENDED (B30)
export type { JobOptions } from '@spinajs/queue';

// stamped on message.Initiator by beforeEmit
export interface Initiator {
  readonly type: PrincipalType;
  readonly id: string;
  readonly ceiling?: Ceiling;
}
