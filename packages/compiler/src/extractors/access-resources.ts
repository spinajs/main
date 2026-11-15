import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthzSection, ModelEntry } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { findDecorator, literalValue } from '../decorators.js';
import { modelMembers } from '../model-members.js';
import { owningPackage } from '../owning-package.js';
import { baseClassOf, declaringPackage } from '../schema/framework-members.js';
import { modelDeclarationOf } from './models.js';

type Resource = AuthzSection['resources'][number];
type ResourceRelation = Resource['relations'][number];

interface Registration {
  type: string;
  options?: Record<string, unknown>;
  node: ts.Node;
}

const RELATION_DECORATORS: Record<string, ResourceRelation['kind']> = { Parent: 'parent', Owner: 'owner', Self: 'self', Relation: 'relation' };

export function classSymbolOf(expr: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(expr);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function registrationCall(node: ts.Node, ctx: ExtractorContext): [ts.Symbol, Registration] | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'registerAccessResource' || node.arguments.length < 2) return undefined;
  const symbol = classSymbolOf(node.arguments[0], ctx.checker);
  const type = literalValue(node.arguments[1], ctx);
  if (!symbol || typeof type !== 'string') return undefined;
  const options = literalValue(node.arguments[2], ctx);
  return [symbol, { type, node, ...(options && typeof options === 'object' ? { options: options as Record<string, unknown> } : {}) }];
}

function registrationDecorator(node: ts.Node, ctx: ExtractorContext): [ts.Symbol, Registration] | undefined {
  if (!ts.isClassDeclaration(node) || !node.name) return undefined;
  const type = literalValue(findDecorator(node, 'AccessResource')?.args[0], ctx);
  const symbol = ctx.checker.getSymbolAtLocation(node.name);
  return symbol && typeof type === 'string' ? [symbol, { type, node }] : undefined;
}

/** `@AccessResource(type)` classes and literal `registerAccessResource(Model, type, options?)` calls; the first one of a class wins, as at runtime. */
function registrationsIn(files: readonly ts.SourceFile[], ctx: ExtractorContext): Map<ts.Symbol, Registration> {
  const out = new Map<ts.Symbol, Registration>();
  const visit = (node: ts.Node): void => {
    const found = registrationDecorator(node, ctx) ?? registrationCall(node, ctx);
    if (found && !out.has(found[0])) out.set(...found);
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return out;
}

/** A base class from a dependency is only a `.d.ts` here, without decorators: its type is in the dependency's fragment. */
function dependencyType(symbol: ts.Symbol): string | undefined {
  const file = symbol.declarations?.[0]?.getSourceFile();
  const owner = file?.isDeclarationFile ? owningPackage(file.fileName) : undefined;
  const fragment = owner?.fragment ? join(owner.root, owner.fragment) : undefined;
  if (!fragment || !existsSync(fragment)) return undefined;
  const { models = [] } = JSON.parse(readFileSync(fragment, 'utf8')) as { models?: ModelEntry[] };
  const type = models.find((m) => m.className === symbol.name)?.accessResource;
  return typeof type === 'string' ? type : undefined;
}

/** The nearest registered class of the chain, as authz-orm's `entryOf` looks it up. */
function registrationOf(symbol: ts.Symbol, registrations: Map<ts.Symbol, Registration>, checker: ts.TypeChecker): { type: string; registration?: Registration } | undefined {
  let current: ts.Type | undefined = checker.getDeclaredTypeOfSymbol(symbol);
  for (let hops = 0; current && hops < 32; hops++) {
    const s = current.getSymbol();
    if (!s) return undefined;
    const registration = registrations.get(s);
    if (registration) return { type: registration.type, registration };
    const inherited = dependencyType(s);
    if (inherited) return { type: inherited };
    current = baseClassOf(checker, current);
  }
  return undefined;
}

const columnOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof (value as { column?: unknown } | undefined)?.column === 'string' ? (value as { column: string }).column : undefined);

function decoratedRelations(symbol: ts.Symbol, ctx: ExtractorContext): ResourceRelation[] {
  return modelMembers(ctx.checker, ctx.checker.getDeclaredTypeOfSymbol(symbol)).flatMap((member) =>
    member.decorators.flatMap((d): ResourceRelation[] => {
      const kind = RELATION_DECORATORS[d.name];
      if (!kind) return [];
      const arg = literalValue(d.args[0], ctx);
      if (kind === 'parent') return typeof arg === 'string' ? [{ name: 'parent', kind, column: member.name, target: arg }] : [];
      if (kind === 'relation') return typeof arg === 'string' ? [{ name: arg, kind, column: member.name }] : [];
      return [{ name: kind, kind, column: member.name }];
    }),
  );
}

function optionRelations(options: Record<string, unknown> | undefined): ResourceRelation[] {
  if (!options) return [];
  const out: ResourceRelation[] = [];
  for (const p of Array.isArray(options.parents) ? (options.parents as { column?: unknown; type?: unknown }[]) : []) {
    if (typeof p?.column === 'string' && typeof p.type === 'string') out.push({ name: 'parent', kind: 'parent', column: p.column, target: p.type });
  }
  const owner = columnOf(options.owner);
  if (owner) out.push({ name: 'owner', kind: 'owner', column: owner });
  if (typeof options.self === 'string') out.push({ name: 'self', kind: 'self', column: options.self });
  for (const [name, columns] of Object.entries((options.relations ?? {}) as Record<string, unknown>)) {
    const column = columnOf(columns);
    if (column) out.push({ name, kind: 'relation', column });
  }
  return out;
}

function relationsOf(symbol: ts.Symbol, registration: Registration | undefined, ctx: ExtractorContext): ResourceRelation[] {
  const seen = new Set<string>();
  return [...decoratedRelations(symbol, ctx), ...optionRelations(registration?.options)].filter((r) => {
    const key = `${r.name}\0${r.column}`;
    return !seen.has(key) && !!seen.add(key);
  });
}

export const modelIdOf = (symbol: ts.Symbol, ctx: ExtractorContext): string => {
  const declaration = symbol.declarations?.[0];
  const pkg = declaration?.getSourceFile().isDeclarationFile ? declaringPackage(declaration) : ctx.packageName;
  return `${pkg}:${symbol.name}`;
};

/**
 * The access resource type of every model, inherited through base classes, and the `authz.resources` of the package:
 * its models, and models of other packages it registers with `registerAccessResource`.
 */
export function accessResources(ctx: ExtractorContext, files: readonly ts.SourceFile[], models: ModelEntry[]): { models: ModelEntry[]; resources: Resource[] } {
  const registrations = registrationsIn(files, ctx);
  const resources: Resource[] = [];
  const covered = new Set<ts.Symbol>();

  const withTypes = models.map((model) => {
    const declaration = modelDeclarationOf(model);
    const symbol = declaration?.name && ctx.checker.getSymbolAtLocation(declaration.name);
    const found = symbol && registrationOf(symbol, registrations, ctx.checker);
    if (!symbol || !found) return model;
    covered.add(symbol);
    const node = found.registration?.node;
    const local = node && !node.getSourceFile().isDeclarationFile;
    resources.push({ type: found.type, model: model.id, relations: relationsOf(symbol, found.registration, ctx), source: local ? ctx.sourceRef(node) : model.source });
    return { ...model, accessResource: found.type };
  });

  for (const [symbol, registration] of registrations) {
    if (covered.has(symbol) || ts.isClassDeclaration(registration.node)) continue;
    resources.push({ type: registration.type, model: modelIdOf(symbol, ctx), relations: relationsOf(symbol, registration, ctx), source: ctx.sourceRef(registration.node) });
  }
  return { models: withTypes, resources };
}
