import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelEntry, ModelTenant, TenancyModel } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { literalValue } from '../decorators.js';
import { owningPackage, type OwningPackage } from '../owning-package.js';
import { baseClassOf } from '../schema/framework-members.js';
import { classSymbolOf, modelIdOf } from './access-resources.js';
import { declaredDecorator, isFunctionOf } from './decorator-origin.js';
import { modelDeclarationOf } from './models.js';

export const TENANCY_ORM = '@spinajs/tenancy-orm';

interface Registration {
  tenant: ModelTenant;
  node: ts.Node;
}

interface Found {
  tenant: ModelTenant;
  registration?: Registration;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only what the options state: a member that is missing or not a literal is the application's default. */
function tenantOf(options: ts.Expression | undefined, ctx: ExtractorContext): ModelTenant {
  const raw = literalValue(options, ctx);
  const stated: Record<string, unknown> = isRecord(raw) ? raw : {};
  const { isolation, column, rls } = stated;
  return {
    ...(isolation === 'row' || isolation === 'schema' ? { isolation } : {}),
    ...(typeof column === 'string' || column === false ? { column } : {}),
    ...(typeof rls === 'boolean' ? { rls } : {}),
  };
}

function decorated(node: ts.Node, ctx: ExtractorContext): [ts.Symbol, Registration] | undefined {
  if (!ts.isClassDeclaration(node) || !node.name) return undefined;
  const found = declaredDecorator(node, TENANCY_ORM, ['Tenant'], ctx);
  const symbol = found && ctx.checker.getSymbolAtLocation(node.name);
  return found && symbol ? [symbol, { tenant: tenantOf(found.decorator.args[0], ctx), node }] : undefined;
}

function registered(node: ts.Node, ctx: ExtractorContext): [ts.Symbol, Registration] | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length === 0 || !isFunctionOf(node.expression, 'registerTenantModel', TENANCY_ORM, ctx.checker)) return undefined;
  const symbol = classSymbolOf(node.arguments[0], ctx.checker);
  return symbol ? [symbol, { tenant: tenantOf(node.arguments[1], ctx), node }] : undefined;
}

/** `@Tenant` classes and literal `registerTenantModel(Model, options?)` calls; the first one of a class wins. */
function registrationsIn(files: readonly ts.SourceFile[], ctx: ExtractorContext): Map<ts.Symbol, Registration> {
  const out = new Map<ts.Symbol, Registration>();
  const visit = (node: ts.Node): void => {
    const found = decorated(node, ctx) ?? registered(node, ctx);
    if (found && !out.has(found[0])) out.set(...found);
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return out;
}

/** A base class from a dependency is only a `.d.ts` here, without decorators: whether it is a tenant model is in the dependency's fragment. */
function dependencyTenants(): (symbol: ts.Symbol) => ModelTenant | undefined {
  const owners = new Map<string, OwningPackage | undefined>();
  const models = new Map<string, ModelEntry[]>();
  const ownerOf = (file: string): OwningPackage | undefined => {
    if (!owners.has(file)) owners.set(file, owningPackage(file));
    return owners.get(file);
  };
  const modelsOf = (fragment: string): ModelEntry[] => {
    let found = models.get(fragment);
    if (!found) {
      found = existsSync(fragment) ? ((JSON.parse(readFileSync(fragment, 'utf8')) as { models?: ModelEntry[] }).models ?? []) : [];
      models.set(fragment, found);
    }
    return found;
  };
  return (symbol) => {
    const file = symbol.declarations?.[0]?.getSourceFile();
    const owner = file?.isDeclarationFile ? ownerOf(file.fileName) : undefined;
    return owner?.fragment ? modelsOf(join(owner.root, owner.fragment)).find((m) => m.className === symbol.name)?.tenant : undefined;
  };
}

const isOfDependency = (symbol: ts.Symbol): boolean => symbol.declarations?.[0]?.getSourceFile().isDeclarationFile === true;

function nearestTenant(symbol: ts.Symbol, registrations: Map<ts.Symbol, Registration>, dependency: (symbol: ts.Symbol) => ModelTenant | undefined, checker: ts.TypeChecker): Found | undefined {
  let current: ts.Type | undefined = checker.getDeclaredTypeOfSymbol(symbol);
  for (let hops = 0; current && hops < 32; hops++) {
    const owner = current.getSymbol();
    if (!owner) return undefined;
    const registration = registrations.get(owner);
    if (registration) return { tenant: registration.tenant, registration };
    const inherited = dependency(owner);
    if (inherited) return { tenant: inherited };
    current = baseClassOf(checker, current);
  }
  return undefined;
}

/**
 * One row per tenant model of the package, then one per model of another package it registers. `models` must be the
 * entries `extractModels` returned: a copy has lost its class declaration.
 */
export function tenantModelsOf(ctx: ExtractorContext, files: readonly ts.SourceFile[], models: ModelEntry[]): TenancyModel[] {
  const registrations = registrationsIn(files, ctx);
  const dependency = dependencyTenants();
  const covered = new Set<ts.Symbol>();
  const rows: TenancyModel[] = [];

  for (const model of models) {
    const declaration = modelDeclarationOf(model);
    const symbol = declaration?.name && ctx.checker.getSymbolAtLocation(declaration.name);
    const found = symbol && nearestTenant(symbol, registrations, dependency, ctx.checker);
    if (!symbol || !found) continue;
    covered.add(symbol);
    rows.push({ model: model.id, tenant: found.tenant, source: found.registration ? ctx.sourceRef(found.registration.node) : model.source });
  }

  for (const [symbol, registration] of registrations) {
    if (covered.has(symbol) || !isOfDependency(symbol)) continue;
    rows.push({ model: modelIdOf(symbol, ctx), tenant: registration.tenant, source: ctx.sourceRef(registration.node) });
  }
  return rows;
}

export function withTenants(models: ModelEntry[], rows: TenancyModel[]): ModelEntry[] {
  const tenants = new Map(rows.map((r) => [r.model, r.tenant]));
  return models.map((model) => {
    const tenant = tenants.get(model.id);
    return tenant ? { ...model, tenant } : model;
  });
}
