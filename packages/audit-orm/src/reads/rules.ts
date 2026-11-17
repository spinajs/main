import type { Constructor } from '@spinajs/di';
import { AuditConfigError } from '@spinajs/audit';
import { extractModelDescriptorInherited } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

export type ReadAuditMode = 'row' | 'query';

export interface AuditReadsOptions {
  /** Default 'default'. */
  readonly trail?: string;
  /** Default 'row'. */
  readonly mode?: ReadAuditMode;
  /** Audit only selects that return one of these; left out, every select of the model. */
  readonly columns?: readonly string[];
  /** Default 'reject'. */
  readonly onFailure?: 'continue' | 'reject';
}

export interface ReadRule {
  readonly model: string;
  readonly trail: string;
  readonly mode: ReadAuditMode;
  readonly columns: readonly string[] | undefined;
  readonly onFailure: 'continue' | 'reject';
}

const MODES: readonly string[] = ['row', 'query'];
const FAILURES: readonly string[] = ['continue', 'reject'];

// Keyed by class name: the ORM hands a builder the registered model of that name (createQuery).
const rules = new Map<string, ReadRule>();

function ruleOf(target: { readonly name: string }, options: AuditReadsOptions): ReadRule {
  const model = target.name;
  const mode = options.mode ?? 'row';
  if (!MODES.includes(mode)) {
    throw new AuditConfigError(`@AuditReads on ${model}: mode must be 'row' or 'query', got ${String(mode)}`);
  }

  const onFailure = options.onFailure ?? 'reject';
  if (!FAILURES.includes(onFailure)) {
    throw new AuditConfigError(`@AuditReads on ${model}: onFailure must be 'continue' or 'reject', got ${String(onFailure)}`);
  }

  const columns = options.columns;
  if (columns !== undefined && (columns.length === 0 || columns.some((c) => typeof c !== 'string' || c === ''))) {
    throw new AuditConfigError(`@AuditReads on ${model}: columns must name at least one column`);
  }

  // Property decorators run before class decorators, so the key is declared by now; a subclass inherits it.
  if (mode === 'row' && (extractModelDescriptorInherited(target)?.PrimaryKey ?? []).length === 0) {
    throw new AuditConfigError(`@AuditReads on ${model}: mode 'row' needs a primary key, and ${model} declares none; use mode 'query'`);
  }

  return { model, trail: options.trail ?? 'default', mode, columns: columns ? [...columns] : undefined, onFailure };
}

/** Declares read auditing for a model of another package. */
export function registerAuditReads(model: Constructor<ModelBase>, options: AuditReadsOptions = {}): void {
  rules.set(model.name, ruleOf(model, options));
}

export function AuditReads(options: AuditReadsOptions = {}): ClassDecorator {
  return (target) => {
    rules.set(target.name, ruleOf(target, options));
  };
}

/** Drops the rule a test registered: the map lives as long as the process and is keyed by class name. Not exported from the package. */
export function forgetAuditReads(model: { readonly name: string }): void {
  rules.delete(model.name);
}

export const hasAuditReads = (): boolean => rules.size !== 0;

/** The rule of the model or of its nearest ancestor that has one: a discrimination map shares its table. */
export function auditReadsOf(model: Constructor<ModelBase> | undefined): ReadRule | undefined {
  for (let type: unknown = model; typeof type === 'function' && type.name !== ''; type = Object.getPrototypeOf(type)) {
    const rule = rules.get(type.name);
    if (rule) return rule;
  }

  return undefined;
}
