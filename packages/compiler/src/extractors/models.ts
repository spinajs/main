import ts from 'typescript';
import type { ModelEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator, identifierName, literalValue } from '../decorators.js';
import { modelMembers } from '../model-members.js';
import { columnSqlSpec, modelIndexes, optionOf, relationKeys } from './model-sql.js';
import { stringArg } from './string-arg.js';

type Relation = ModelEntry['relations'][number];
type Column = ModelEntry['columns'][number];

const RELATIONS: Record<string, { kind: Relation['kind']; targetArg: number }> = {
  BelongsTo: { kind: 'belongsTo', targetArg: 0 },
  ForwardBelongsTo: { kind: 'forwardBelongsTo', targetArg: 0 },
  HasMany: { kind: 'hasMany', targetArg: 0 },
  HasManyToMany: { kind: 'hasManyToMany', targetArg: 1 },
};
const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
// the ORM leaves these empty until an update, a soft delete or an archive, so an insert writes NULL whatever the TS type says
const FILLED_LATER = new Set(['UpdatedAt', 'SoftDelete', 'Archived']);

function relationTarget(expr: ts.Expression | undefined, ctx: ExtractorContext): string {
  if (expr && ts.isObjectLiteralExpression(expr)) {
    const fwd = expr.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'forwardRef');
    const body = fwd && ts.isArrowFunction(fwd.initializer) ? fwd.initializer.body : undefined;
    return (body && ts.isExpression(body) ? identifierName(body) : undefined) ?? 'unknown';
  }
  return identifierName(expr) ?? stringArg(expr, ctx, 'unknown');
}

function stripNullable(type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const rest = type.types.filter((t) => !(t.flags & NULLISH));
  return rest.length === 1 ? rest[0] : type;
}

const isNullable = (type: ts.Type, optional: boolean): boolean => optional || (type.isUnion() && type.types.some((t) => t.flags & NULLISH));

function readMembers(node: ts.ClassDeclaration, ctx: ExtractorContext): Pick<ModelEntry, 'columns' | 'relations'> {
  const columns: Column[] = [];
  const className = node.name?.text ?? '';
  const relations: Relation[] = [];
  const symbol = node.name && ctx.checker.getSymbolAtLocation(node.name);
  if (!symbol) return { columns, relations };
  for (const member of modelMembers(ctx.checker, ctx.checker.getDeclaredTypeOfSymbol(symbol))) {
    if (member.kind === 'computed') continue;
    if (member.kind === 'relation') {
      // A relation typed but not decorated has no kind or target to record.
      const rel = member.decorators.find((d) => RELATIONS[d.name]);
      if (rel) {
        const target = relationTarget(rel.args[RELATIONS[rel.name].targetArg], ctx);
        relations.push({ name: member.name, kind: RELATIONS[rel.name].kind, target, ...relationKeys(rel, member.name, className, target, ctx) });
      }
      continue;
    }
    columns.push({
      name: member.name,
      type: ctx.typeRef(stripNullable(member.type), member.declaration, `${className}_${member.name}`),
      primary: member.decorators.some((d) => d.name === 'Primary'),
      nullable: isNullable(member.type, member.optional) || member.decorators.some((d) => FILLED_LATER.has(d.name)),
      sql: columnSqlSpec(member, ctx),
    });
  }
  return { columns, relations };
}

function modelExtras(node: ts.ClassDeclaration, options: ts.Expression | undefined, columns: Column[], ctx: ExtractorContext): Pick<ModelEntry, 'indexes' | 'version' | 'exhaustive'> {
  const extras: Pick<ModelEntry, 'indexes' | 'version' | 'exhaustive'> = {};
  const indexes = modelIndexes(node, ctx);
  const version = columns.find((c) => c.sql?.version)?.name;
  if (indexes.length > 0) extras.indexes = indexes;
  if (version) extras.version = version;
  if (stringArg(optionOf(options, 'columns'), ctx) === 'exhaustive') extras.exhaustive = true;
  return extras;
}

export const extractModels: Extractor<ModelEntry> = (ctx, file) => {
  const out: ModelEntry[] = [];
  const visit = (node: ts.Node): void => {
    const model = ts.isClassDeclaration(node) && node.name ? findDecorator(node, 'Model') : undefined;
    if (ts.isClassDeclaration(node) && node.name && model) {
      const connection = literalValue(findDecorator(node, 'Connection')?.args[0], ctx) as string | undefined;
      const members = readMembers(node, ctx);
      out.push({
        id: `${ctx.packageName}:${node.name.text}`,
        className: node.name.text,
        tableName: stringArg(model.args[0], ctx),
        ...(connection ? { connection } : {}),
        ...members,
        ...modelExtras(node, model.args[1], members.columns, ctx),
        accessResource: !!findDecorator(node, 'AccessResource'),
        source: ctx.sourceRef(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
