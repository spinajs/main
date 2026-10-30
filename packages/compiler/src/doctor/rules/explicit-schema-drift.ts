import type { Diagnostic } from '@spinajs/manifest';
import type { DoctorRule } from '../rule.js';
import type { JsonSchema } from '../../schema/derive.js';
import { compareCodeUnits } from '../../sort.js';

const propertiesOf = (schema: JsonSchema): Record<string, JsonSchema> => (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
const requiredOf = (schema: JsonSchema): string[] => [...((schema.required as string[] | undefined) ?? [])].sort(compareCodeUnits);

function shapeOf(property: JsonSchema | undefined): string | undefined {
  if (!property) return undefined;
  if (typeof property.type === 'string') return property.type;
  if (Array.isArray(property.enum)) return 'enum';
  if (typeof property.$ref === 'string') return property.$ref;
  return undefined;
}

export function structuralDiff(explicit: JsonSchema, derived: JsonSchema): string[] {
  const out: string[] = [];
  const explicitProps = propertiesOf(explicit);
  const derivedProps = propertiesOf(derived);
  for (const name of Object.keys(derivedProps)) if (!(name in explicitProps)) out.push(`property ${name} only in class`);
  for (const name of Object.keys(explicitProps)) if (!(name in derivedProps)) out.push(`property ${name} only in schema`);
  for (const name of Object.keys(explicitProps)) {
    const a = shapeOf(explicitProps[name]);
    const b = shapeOf(derivedProps[name]);
    if (a && b && a !== b) out.push(`property ${name}: schema type ${a}, class type ${b}`);
  }
  const explicitRequired = requiredOf(explicit);
  const derivedRequired = requiredOf(derived);
  if (explicitRequired.join(',') !== derivedRequired.join(',')) {
    out.push(`required differs: schema [${explicitRequired.join(', ')}], class [${derivedRequired.join(', ')}]`);
  }
  return out;
}

export const explicitSchemaDrift: DoctorRule = {
  code: 'SCH003',
  describe: 'an explicit @Schema differs structurally from the schema derived from its class',
  run(manifest): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const [id, value] of Object.entries(manifest.schemas)) {
      const schema = value as JsonSchema;
      const derived = schema['x-derived'] as JsonSchema | undefined;
      if (!derived || schema['x-explicit'] === 'partial') continue;
      const diffs = structuralDiff(schema, derived);
      if (diffs.length) out.push({ code: 'SCH003', severity: 'warning', message: `${id}: explicit schema drifts from the class: ${diffs.join('; ')}` });
    }
    return out;
  },
};
