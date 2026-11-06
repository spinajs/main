import ts from 'typescript';
import type { ColumnFamily, ColumnSqlSpec, ModelIndex, ModelRelation } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, identifierName, literalValue, type DecoratorInfo } from '../decorators.js';
import type { ModelMember } from '../model-members.js';

const DECORATOR_FAMILIES = new Map<string, ColumnFamily>([
  ['Json', 'json'],
  ['Int64', 'bigint'],
  ['Uuid', 'uuid'],
  ['Bool', 'boolean'],
  ['DateTime', 'datetime'],
  ['CreatedAt', 'datetime'],
  ['UpdatedAt', 'datetime'],
  ['SoftDelete', 'datetime'],
  ['Archived', 'datetime'],
]);
const DATE_TYPES = new Set(['Date', 'DateTime']);
const BINARY_TYPES = new Set(['Uint8Array', 'Buffer']);
const SPEC_KEYS = ['family', 'nativeType', 'length', 'precision', 'scale', 'unsigned', 'default', 'autoIncrement', 'unique', 'enumValues', 'version'] as const;

const everyMember = (type: ts.Type, flags: ts.TypeFlags): boolean => (type.isUnion() ? type.types : [type]).every((t) => (t.flags & flags) !== 0);

/** D8: the family of a column without `@Column`, from its non-nullable TypeScript type. */
export function typeFamily(type: ts.Type): ColumnFamily {
  if (everyMember(type, ts.TypeFlags.NumberLike)) return 'integer';
  if (everyMember(type, ts.TypeFlags.BigIntLike)) return 'bigint';
  if (everyMember(type, ts.TypeFlags.StringLike)) return 'text';
  if (everyMember(type, ts.TypeFlags.BooleanLike)) return 'boolean';
  const name = type.getSymbol()?.name ?? '';
  if (DATE_TYPES.has(name)) return 'datetime';
  if (BINARY_TYPES.has(name)) return 'binary';
  return 'json';
}

/** The initializer of `key` in an object-literal argument. The other members (factories, classes) are not evaluated. */
export function optionOf(options: ts.Expression | undefined, key: string): ts.Expression | undefined {
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const found = options.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key);
  return found?.initializer;
}

function stringValue(expr: ts.Expression | undefined, ctx: ExtractorContext): string | undefined {
  if (!expr || (ts.isIdentifier(expr) && expr.text === 'undefined')) return undefined;
  const value = literalValue(expr, ctx);
  return typeof value === 'string' ? value : undefined;
}

function explicitSpec(decorator: DecoratorInfo, ctx: ExtractorContext): Partial<ColumnSqlSpec> {
  const value = decorator.args[0] ? literalValue(decorator.args[0], ctx) : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(SPEC_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
}

function keyGeneration(member: ModelMember, ctx: ExtractorContext): string | undefined {
  const primary = member.decorators.find((d) => d.name === 'Primary');
  return primary ? (stringValue(optionOf(primary.args[0], 'generated'), ctx) ?? 'auto') : undefined;
}

export function columnSqlSpec(member: ModelMember, ctx: ExtractorContext): ColumnSqlSpec {
  const column = member.decorators.find((d) => d.name === 'Column');
  const generated = keyGeneration(member, ctx);
  const fromDecorator = member.decorators.map((d) => DECORATOR_FAMILIES.get(d.name)).find((f) => f !== undefined);
  const inferred: ColumnFamily = generated === 'uuid' ? 'uuid' : (fromDecorator ?? typeFamily(ctx.checker.getNonNullableType(member.type)));
  const explicit = column ? explicitSpec(column, ctx) : {};
  const spec: ColumnSqlSpec = { ...explicit, family: explicit.family ?? inferred };
  if (generated === 'auto' && spec.autoIncrement === undefined && (spec.family === 'integer' || spec.family === 'bigint')) spec.autoIncrement = true;
  if (member.decorators.some((d) => d.name === 'Version')) spec.version = true;
  // Q15: `inferred` is about the family only. `@Column({ unique: true })` states no family, so its family is as inferred as a bare field's.
  if (explicit.family === undefined) spec.inferred = true;
  return spec;
}

type RelationKeys = Pick<ModelRelation, 'foreignKey' | 'primaryKey' | 'junction'>;

const defined = (keys: RelationKeys): RelationKeys => Object.fromEntries(Object.entries(keys).filter(([, v]) => v !== undefined));

/** The join columns as `orm/src/decorators.ts` defaults them; a key that defaults to a primary key is left out (see `ModelRelation`). */
export function relationKeys(rel: DecoratorInfo, member: string, owner: string, target: string, ctx: ExtractorContext): RelationKeys {
  if (rel.name === 'HasMany') {
    const options = rel.args[1];
    return defined({ foreignKey: stringValue(optionOf(options, 'foreignKey'), ctx) ?? `${owner.toLowerCase()}_id`, primaryKey: stringValue(optionOf(options, 'primaryKey'), ctx) });
  }
  if (rel.name === 'HasManyToMany') {
    const options = rel.args[2];
    return defined({
      foreignKey: stringValue(optionOf(options, 'targetModelPKey'), ctx),
      primaryKey: stringValue(optionOf(options, 'sourceModelPKey'), ctx),
      junction: {
        model: identifierName(rel.args[0]) ?? 'unknown',
        sourceKey: stringValue(optionOf(options, 'junctionModelSourcePk'), ctx) ?? `${owner.toLowerCase()}_id`,
        targetKey: stringValue(optionOf(options, 'junctionModelTargetPk'), ctx) ?? `${target.toLowerCase()}_id`,
      },
    });
  }
  // BelongsTo and ForwardBelongsTo take (target, foreignKey?, primaryKey?).
  return defined({ foreignKey: stringValue(rel.args[1], ctx) ?? `${member.toLowerCase()}_id`, primaryKey: stringValue(rel.args[2], ctx) });
}

export function modelIndexes(node: ts.ClassDeclaration, ctx: ExtractorContext): ModelIndex[] {
  return decoratorsOf(node)
    .filter((d) => d.name === 'Index')
    .flatMap((d) => {
      const columns = literalValue(d.args[0], ctx);
      if (!Array.isArray(columns) || columns.length === 0 || !columns.every((c) => typeof c === 'string')) return [];
      const name = stringValue(optionOf(d.args[1], 'name'), ctx);
      const unique = literalValue(optionOf(d.args[1], 'unique'), ctx) === true;
      return [{ ...(name ? { name } : {}), columns, unique }];
    });
}
