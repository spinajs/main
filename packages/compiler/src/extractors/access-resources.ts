import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthzSection, ModelEntry } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { findDecorator, literalValue, type DecoratorInfo } from '../decorators.js';
import { modelMembers, type ModelMember } from '../model-members.js';
import { owningPackage } from '../owning-package.js';
import { baseClassOf, declaringPackage } from '../schema/framework-members.js';
import { compareCodeUnits } from '../sort.js';
import { modelDeclarationOf } from './models.js';
import { constantValueOf, isPlainJson, memberOf, objectLiteralOf, readsConstantsOnly, type MemberRead } from './object-literals.js';

type Resource = AuthzSection['resources'][number];
type ResourceRelation = Resource['relations'][number];

interface Registration {
  type: string;
  options?: Record<string, unknown>;
  node: ts.Node;
  /** What authz-orm compares two registrations of one class by; absent when the build cannot read every option. */
  key?: string;
}

const RELATION_DECORATORS: Record<string, ResourceRelation['kind']> = { Parent: 'parent', Owner: 'owner', Self: 'self', Relation: 'relation' };

export function classSymbolOf(expr: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(expr);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

export interface ResourceColumns {
  column: string;
  typeColumn?: string;
}

const isOptions = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An owner or a named relation as the options state it: a column name, or `{ column, typeColumn? }`. */
export function columnsOf(value: unknown): ResourceColumns | undefined {
  if (typeof value === 'string') return { column: value };
  if (!isOptions(value) || typeof value.column !== 'string') return undefined;
  return typeof value.typeColumn === 'string' ? { column: value.column, typeColumn: value.typeColumn } : { column: value.column };
}

const columnsKey = (value: unknown): [string, string | null] | null => {
  const columns = columnsOf(value);
  return columns ? [columns.column, columns.typeColumn ?? null] : null;
};

/** The canonical key of authz-orm's `normalize` (registry.ts), from options the build read in full. */
function registrationKey(type: string, o: Readonly<Record<string, unknown>>): string {
  const parents = (Array.isArray(o.parents) ? (o.parents as { column?: unknown; type?: unknown }[]) : []).map((p) => [p?.column ?? null, p?.type ?? null]);
  const relations =
    o.relations === undefined
      ? null
      : Object.entries(o.relations as Record<string, unknown>)
          .sort(([a], [b]) => compareCodeUnits(a, b))
          .map(([name, columns]) => [name, ...(columnsKey(columns) ?? [null, null])]);
  const rls = o.rls === true || o.rls === 'partial' ? o.rls : null;
  return JSON.stringify([type, parents, columnsKey(o.owner), typeof o.self === 'string' ? o.self : null, relations, rls, o.changelog !== false]);
}

/**
 * The literal options of a registration, and whether the build read every part of them. Only those are compared: a
 * guessed key would be a false build error. They must lead to an object literal through constants only, as `@Access`
 * options do, read no `let` or `var` at any depth, and nothing in them may need a `CMP001` note (a spread, key or
 * value the build cannot read).
 */
function optionsOf(argument: ts.Expression | undefined, ctx: ExtractorContext): { options?: Record<string, unknown>; readable: boolean } {
  if (!argument) return { readable: true };
  let unread = !objectLiteralOf(argument, ctx) || !readsConstantsOnly(argument, ctx);
  const value = literalValue(argument, {
    checker: ctx.checker,
    info: (code, message, node) => {
      unread = true;
      ctx.info(code, message, node);
    },
  });
  const options = isOptions(value) ? value : undefined;
  const readable = !unread && !!options && isPlainJson(options);
  if (!readable) ctx.info('CMP001', `the options of this access resource registration cannot be read at build time (${argument.getText()}): AUTHZ012 does not compare it`, argument);
  return { ...(options ? { options } : {}), readable };
}

function registrationCall(node: ts.Node, ctx: ExtractorContext): [ts.Symbol, Registration] | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'registerAccessResource' || node.arguments.length < 2) return undefined;
  const symbol = classSymbolOf(node.arguments[0], ctx.checker);
  const type = literalValue(node.arguments[1], ctx);
  if (!symbol || typeof type !== 'string') return undefined;
  const { options, readable } = optionsOf(node.arguments[2], ctx);
  return [symbol, { type, node, ...(options ? { options } : {}), ...(readable ? { key: registrationKey(type, options ?? {}) } : {}) }];
}

function registrationDecorator(node: ts.Node, ctx: ExtractorContext): [ts.Symbol, Registration] | undefined {
  if (!ts.isClassDeclaration(node) || !node.name) return undefined;
  const decorator = findDecorator(node, 'AccessResource');
  const type = literalValue(decorator?.args[0], ctx);
  const symbol = ctx.checker.getSymbolAtLocation(node.name);
  if (!symbol || typeof type !== 'string') return undefined;
  const { options, readable } = optionsOf(decorator?.args[1], ctx);
  // The decorator hands the registry these two options only (authz-orm decorators.ts).
  const passed = { changelog: options?.changelog, rls: options?.rls };
  return [symbol, { type, node, ...(readable ? { key: registrationKey(type, passed) } : {}) }];
}

/**
 * `@AccessResource(type)` classes and literal `registerAccessResource(Model, type, options?)` calls. The first one of a
 * class is kept; a later one with another key is the registration authz-orm refuses at startup.
 */
function registrationsIn(files: readonly ts.SourceFile[], ctx: ExtractorContext): Map<ts.Symbol, Registration> {
  const out = new Map<ts.Symbol, Registration>();
  const add = (symbol: ts.Symbol, registration: Registration): void => {
    const first = out.get(symbol);
    if (!first) {
      out.set(symbol, registration);
    } else if (first.key !== undefined && registration.key !== undefined && first.key !== registration.key) {
      ctx.error('AUTHZ012', `${symbol.name} is already registered as resource '${first.type}' with other options; authz-orm refuses the second registration when the application starts`, registration.node);
    }
  };
  const visit = (node: ts.Node): void => {
    const found = registrationDecorator(node, ctx) ?? registrationCall(node, ctx);
    if (found) add(...found);
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

type RelationFacts = Pick<ResourceRelation, 'typeColumn' | 'nullable' | 'unread'>;
type Unread = NonNullable<ResourceRelation['unread']>[number];

/** The context of reading relations, with a `CMP001` note that is written once per node however many resources share it. */
interface RelationScope {
  ctx: ExtractorContext;
  note: (node: ts.Node, message: string) => void;
}

const UNREAD_NOTE = 'is recorded as unread in authz.resources';

const typeColumnFacts = (value: unknown): RelationFacts | undefined => (value === undefined ? {} : typeof value === 'string' ? { typeColumn: value } : undefined);
const nullableFacts = (value: unknown): RelationFacts => (value === true ? { nullable: true } : {});

/** A relation decorator's option as authz-orm reads it; one the build cannot read, or one authz-orm refuses, is `unread`. */
function decoratorFacts(d: DecoratorInfo, options: ts.Expression | undefined, key: Unread, facts: (value: unknown) => RelationFacts | undefined, scope: RelationScope): RelationFacts {
  const quiet = { checker: scope.ctx.checker, info: () => undefined };
  const read: MemberRead = options ? memberOf(options, key, quiet) : { set: false };
  const value = !read.set ? { value: undefined } : read.value ? constantValueOf(read.value, quiet) : undefined;
  const known = value && facts(value.value);
  if (known) return known;
  const at = options ?? d.node;
  scope.note(at, `the ${key} option of @${d.name} cannot be read at build time (${at.getText()}): it ${UNREAD_NOTE}`);
  return { unread: [key] };
}

function decoratedRelation(member: ModelMember, d: DecoratorInfo, scope: RelationScope): ResourceRelation[] {
  const kind = RELATION_DECORATORS[d.name];
  if (!kind) return [];
  const first = literalValue(d.args[0], scope.ctx);
  // `@Parent(type, options)` and `@Relation(name, options)` take their options second, `@Owner(options)` first.
  if (kind === 'parent') return typeof first === 'string' ? [{ name: 'parent', kind, column: member.name, target: first, ...decoratorFacts(d, d.args[1], 'nullable', nullableFacts, scope) }] : [];
  if (kind === 'relation') return typeof first === 'string' ? [{ name: first, kind, column: member.name, ...decoratorFacts(d, d.args[1], 'typeColumn', typeColumnFacts, scope) }] : [];
  return [{ name: kind, kind, column: member.name, ...(kind === 'owner' ? decoratorFacts(d, d.args[0], 'typeColumn', typeColumnFacts, scope) : {}) }];
}

function decoratedRelations(symbol: ts.Symbol, scope: RelationScope): ResourceRelation[] {
  return modelMembers(scope.ctx.checker, scope.ctx.checker.getDeclaredTypeOfSymbol(symbol)).flatMap((member) => member.decorators.flatMap((d) => decoratedRelation(member, d, scope)));
}

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const optionParents = (parents: unknown): ResourceRelation[] =>
  listOf(parents).flatMap((p): ResourceRelation[] => (isOptions(p) && typeof p.column === 'string' && typeof p.type === 'string' ? [{ name: 'parent', kind: 'parent', column: p.column, target: p.type }] : []));

/**
 * The relations of registration options. Options the build read in full give exact columns; from a partial read a type
 * column may hide behind the part it could not read, so owners and relations get it `unread`. Parents of options are
 * never nullable (authz-orm registry.ts).
 */
function optionRelations(registration: Registration | undefined, scope: RelationScope): ResourceRelation[] {
  const options = registration?.options;
  if (!registration || !options) return [];
  const exact = registration.key !== undefined;
  const columns = (value: unknown): Pick<ResourceRelation, 'column' | 'typeColumn' | 'unread'> | undefined => {
    const read = columnsOf(value);
    return read && !exact ? { column: read.column, unread: ['typeColumn'] } : read;
  };
  const out = optionParents(options.parents);
  const owner = columns(options.owner);
  if (owner) out.push({ name: 'owner', kind: 'owner', ...owner });
  if (typeof options.self === 'string') out.push({ name: 'self', kind: 'self', column: options.self });
  for (const [name, declared] of Object.entries(isOptions(options.relations) ? options.relations : {})) {
    const relation = columns(declared);
    if (relation) out.push({ name, kind: 'relation', ...relation });
  }
  const at = ts.isCallExpression(registration.node) ? registration.node.arguments[2] : undefined;
  if (at && out.some((r) => r.unread)) scope.note(at, `the options of this access resource registration cannot be read in full (${at.getText()}): the typeColumn of its owner and relations ${UNREAD_NOTE}`);
  return out;
}

function relationsOf(symbol: ts.Symbol, registration: Registration | undefined, scope: RelationScope): ResourceRelation[] {
  const seen = new Set<string>();
  return [...decoratedRelations(symbol, scope), ...optionRelations(registration, scope)].filter((r) => {
    const key = `${r.name}\0${r.column}`;
    return !seen.has(key) && !!seen.add(key);
  });
}

/** The package that declares `symbol` when it is not the analysed one, whether the program sees its declarations or its sources. */
export const otherPackageOf = (symbol: ts.Symbol, ctx: ExtractorContext): string | undefined => {
  const declaration = symbol.declarations?.[0];
  const pkg = declaration && declaringPackage(declaration);
  return pkg !== ctx.packageName ? pkg : undefined;
};

export const modelIdOf = (symbol: ts.Symbol, ctx: ExtractorContext): string => `${otherPackageOf(symbol, ctx) ?? ctx.packageName}:${symbol.name}`;

/**
 * The access resource type of every model, inherited through base classes, and the `authz.resources` of the package:
 * its models, and models of other packages it registers with `registerAccessResource`.
 */
export function accessResources(ctx: ExtractorContext, files: readonly ts.SourceFile[], models: ModelEntry[]): { models: ModelEntry[]; resources: Resource[] } {
  const registrations = registrationsIn(files, ctx);
  const resources: Resource[] = [];
  const covered = new Set<ts.Symbol>();
  const noted = new Set<ts.Node>();
  const scope: RelationScope = {
    ctx,
    note: (node, message) => {
      if (!noted.has(node)) ctx.info('CMP001', message, node);
      noted.add(node);
    },
  };

  const withTypes = models.map((model) => {
    const declaration = modelDeclarationOf(model);
    const symbol = declaration?.name && ctx.checker.getSymbolAtLocation(declaration.name);
    const found = symbol && registrationOf(symbol, registrations, ctx.checker);
    if (!symbol || !found) return model;
    covered.add(symbol);
    const node = found.registration?.node;
    const local = node && !node.getSourceFile().isDeclarationFile;
    resources.push({ type: found.type, model: model.id, relations: relationsOf(symbol, found.registration, scope), source: local ? ctx.sourceRef(node) : model.source });
    return { ...model, accessResource: found.type };
  });

  for (const [symbol, registration] of registrations) {
    if (covered.has(symbol) || ts.isClassDeclaration(registration.node)) continue;
    resources.push({ type: registration.type, model: modelIdOf(symbol, ctx), relations: relationsOf(symbol, registration, scope), source: ctx.sourceRef(registration.node) });
  }
  return { models: withTypes, resources };
}
