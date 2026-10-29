import ts from 'typescript';
import type { ModelEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, identifierName, literalValue } from '../decorators.js';
import { stringArg } from './string-arg.js';

type Relation = ModelEntry['relations'][number];
type Column = ModelEntry['columns'][number];

const RELATIONS: Record<string, { kind: Relation['kind']; targetArg: number }> = {
  BelongsTo: { kind: 'belongsTo', targetArg: 0 },
  ForwardBelongsTo: { kind: 'forwardBelongsTo', targetArg: 0 },
  HasMany: { kind: 'hasMany', targetArg: 0 },
  HasManyToMany: { kind: 'hasManyToMany', targetArg: 1 },
};
const NON_COLUMN = new Set(['Virtual', 'Query', 'Historical', ...Object.keys(RELATIONS)]);
const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined;

function relationTarget(expr: ts.Expression | undefined, ctx: ExtractorContext): string {
  if (expr && ts.isObjectLiteralExpression(expr)) {
    const fwd = expr.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'forwardRef');
    const body = fwd && ts.isArrowFunction(fwd.initializer) ? fwd.initializer.body : undefined;
    return (body && ts.isExpression(body) ? identifierName(body) : undefined) ?? 'unknown';
  }
  return identifierName(expr) ?? stringArg(expr, ctx, 'unknown');
}

function isNullable(type: ts.Type, prop: ts.PropertyDeclaration): boolean {
  return !!prop.questionToken || (type.isUnion() && type.types.some((t) => t.flags & NULLISH));
}

function stripNullable(type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const rest = type.types.filter((t) => !(t.flags & NULLISH));
  return rest.length === 1 ? rest[0] : type;
}

function readMembers(node: ts.ClassDeclaration, ctx: ExtractorContext): Pick<ModelEntry, 'columns' | 'relations'> {
  const columns: Column[] = [];
  const relations: Relation[] = [];
  for (const m of node.members) {
    if (!ts.isPropertyDeclaration(m) || !ts.isIdentifier(m.name) || m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)) continue;
    const decs = decoratorsOf(m);
    const rel = decs.find((d) => RELATIONS[d.name]);
    if (rel) {
      const spec = RELATIONS[rel.name];
      relations.push({ name: m.name.text, kind: spec.kind, target: relationTarget(rel.args[spec.targetArg], ctx) });
      continue;
    }
    if (decs.some((d) => NON_COLUMN.has(d.name))) continue;
    const type = ctx.checker.getTypeAtLocation(m);
    columns.push({ name: m.name.text, type: ctx.typeRef(stripNullable(type), m), primary: decs.some((d) => d.name === 'Primary'), nullable: isNullable(type, m) });
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
