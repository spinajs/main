import ts from 'typescript';
import type { ModelEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator, identifierName, literalValue } from '../decorators.js';
import { modelMembers } from '../model-members.js';
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
      if (rel) relations.push({ name: member.name, kind: RELATIONS[rel.name].kind, target: relationTarget(rel.args[RELATIONS[rel.name].targetArg], ctx) });
      continue;
    }
    columns.push({
      name: member.name,
      type: ctx.typeRef(stripNullable(member.type), member.declaration, `${className}_${member.name}`),
      primary: member.decorators.some((d) => d.name === 'Primary'),
      nullable: isNullable(member.type, member.optional),
    });
  }
  return { columns, relations };
}

export const extractModels: Extractor<ModelEntry> = (ctx, file) => {
  const out: ModelEntry[] = [];
  const visit = (node: ts.Node): void => {
    const model = ts.isClassDeclaration(node) && node.name ? findDecorator(node, 'Model') : undefined;
    if (ts.isClassDeclaration(node) && node.name && model) {
      const connection = literalValue(findDecorator(node, 'Connection')?.args[0], ctx) as string | undefined;
      out.push({
        id: `${ctx.packageName}:${node.name.text}`,
        className: node.name.text,
        tableName: stringArg(model.args[0], ctx),
        ...(connection ? { connection } : {}),
        ...readMembers(node, ctx),
        accessResource: !!findDecorator(node, 'AccessResource'),
        source: ctx.sourceRef(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
