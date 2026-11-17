import { AuditConfigError } from '../index.js';

export interface AuditMessageOptions {
  /** Default 'default'. */
  readonly trail?: string;
  /** Properties of the message recorded in `data.fields`; none by default. */
  readonly fields?: readonly string[];
  readonly onFailure?: 'continue' | 'reject';
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

/** On a job or event class: its publishes and its executions are recorded in an audit trail. */
export function Audited(action: string, options: AuditMessageOptions = {}): ClassDecorator {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new AuditConfigError('@Audited needs an action name');
  }

  return (target) => {
    rules.set(target, { ...options, action, trail: options.trail ?? 'default' });
  };
}

export const messageRuleOf = (message: object): MessageRule | undefined => rules.get(message.constructor);
