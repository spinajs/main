import { AUDIT_WIDTHS, AuditConfigError } from '../index.js';
import { assertMaskPaths } from '../mask.js';

export interface AuditMessageOptions {
  /** Default 'default'. */
  readonly trail?: string;
  /** Properties of the message recorded in `data.fields`; none by default. */
  readonly fields?: readonly string[];
  readonly onFailure?: 'continue' | 'reject';
  /** Paths are written `data.fields.<name>`, as for every audit write. */
  readonly omit?: readonly string[];
  readonly mask?: readonly string[];
  readonly hash?: readonly string[];
}

export interface MessageRule extends AuditMessageOptions {
  readonly action: string;
  readonly trail: string;
}

// Own rule per class, like @Job options: a subclass does not inherit it.
const rules = new WeakMap<object, MessageRule>();
// QueueJob.emit() and QueueEvent.emit() publish a plain object that names its class only by `Name`, and the consumer
// matches deliveries by that name too, so two audited classes of one name could not be told apart.
const byName = new Map<string, { readonly target: object; readonly rule: MessageRule }>();

/** On a job or event class: its publishes and its executions are recorded in an audit trail. */
export function Audited(action: string, options: AuditMessageOptions = {}): ClassDecorator {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new AuditConfigError('@Audited needs an action name');
  }
  if (action.length > AUDIT_WIDTHS.action) {
    throw new AuditConfigError(`@Audited action must be at most ${AUDIT_WIDTHS.action} characters`);
  }
  assertMaskPaths(`@Audited(${JSON.stringify(action)})`, { omit: options.omit ?? [], mask: options.mask ?? [], hash: options.hash ?? [] });

  return (target) => {
    const taken = byName.get(target.name);
    if (taken && taken.target !== target) {
      throw new AuditConfigError(`@Audited: another class named ${JSON.stringify(target.name)} is already audited, and the queue tells messages apart by class name`);
    }
    const rule: MessageRule = { ...options, action, trail: options.trail ?? 'default' };
    rules.set(target, rule);
    byName.set(target.name, { target, rule });
  };
}

export const messageRuleOf = (message: { readonly Name?: string }): MessageRule | undefined => rules.get(message.constructor) ?? (typeof message.Name === 'string' ? byName.get(message.Name)?.rule : undefined);
