import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import type { Constructor } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

export const DEFAULT_HISTORY_TRAIL = 'history';

// The pattern @spinajs/audit accepts for a key of audit.trails.
const TRAIL_NAME = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';

// The audit root is open: each section under it is validated by the package that reads it.
// The section and a rule are closed with propertyNames, not additionalProperties, as in @spinajs/audit: the
// configuration's removeAdditional would drop a misspelt key silently. Each enum lists every key of its properties.
export const AUDIT_DATA_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/orm-history.audit-data.configuration.schema.json',
  $configurationModule: 'audit.data',
  description: 'Row history of ORM models (audit.data.*)',
  type: 'object',
  propertyNames: { enum: ['rules'] },
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['models'],
        propertyNames: { enum: ['models', 'trail'] },
        properties: {
          models: { anyOf: [{ const: '*' }, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }] },
          trail: { type: 'string', pattern: TRAIL_NAME },
        },
      },
    },
  },
};

registerConfigurationSchemaAtImport(AUDIT_DATA_CONFIGURATION_SCHEMA);

/** One entry of `audit.data.rules`, in the shape the schema above accepts. */
export interface DataRule {
  readonly models: '*' | readonly string[];
  /** Default `history`. */
  readonly trail?: string;
}

/** `model` and its base classes, nearest first. */
export function* lineageOf(model: Constructor<ModelBase>): Generator<Constructor<ModelBase>> {
  for (let c: unknown = model; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) yield c as Constructor<ModelBase>;
}

/** The first rule that names the model or one of its base classes, or matches everything. */
export function ruleFor(model: Constructor<ModelBase>, rules: readonly DataRule[]): DataRule | undefined {
  if (rules.length === 0) return undefined;
  const names = [...lineageOf(model)].map((c) => c.name);
  return rules.find((r) => r.models === '*' || r.models.some((n) => names.includes(n)));
}
