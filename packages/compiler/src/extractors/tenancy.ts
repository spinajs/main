import ts from 'typescript';
import { DECLARED_ENTRY_TENANCY, TENANT_MIDDLEWARE, undeclaredTenancy } from '@spinajs/manifest';
import type { AuthzSection, ControllerEntry, ManifestFragment, ScheduleEntry, TenancyDeclaration, TenancyEntryPoint, TenancyModel, TenancySection } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, identifierName, literalValue, type DecoratorInfo } from '../decorators.js';
import { baseClassOf } from '../schema/framework-members.js';
import { classesBySource } from './access-options.js';
import { routeEntryId, sourceKey } from './authz.js';
import { decoratorOrigin, programDeclares } from './decorator-origin.js';
import { ignoreCommentsIn } from './ignore-comments.js';
import { optionOf } from './model-sql.js';
import { literalText } from './string-arg.js';
import { escapesIn } from './tenancy-escapes.js';

export const TENANCY_HTTP = '@spinajs/tenancy-http';

const ROUTE_DECORATORS = ['TenantRoute', 'NoTenant', 'AllTenants'] as const;
const IGNORE = /\/\/[^\S\r\n]*spinajs-tenancy-ignore[^\S\r\n]+(TEN\d{3})[^\S\r\n]*:[^\S\r\n]*(.*\S)/g;

type EntryPoint = AuthzSection['entryPoints'][number];

interface Declaration {
  declared: TenancyDeclaration;
  reason?: string;
}

export interface TenancyInputs {
  controllers: ControllerEntry[];
  schedules: ScheduleEntry[];
  authz: AuthzSection | undefined;
  models: TenancyModel[];
}

/** A hand-written `@Middleware(TenantMiddleware, ...)`: it decides the route at run time, but the build reads no declaration from it (M21). */
const HAND_MOUNTED = 'hand-mounted';

type Mount = Declaration | typeof HAND_MOUNTED;

function mountOf(decorator: DecoratorInfo, ctx: ExtractorContext): Mount | undefined {
  const origin = decoratorOrigin(decorator, ctx);
  if (origin?.package === '@spinajs/http' && origin.name === 'Middleware') return identifierName(decorator.args[0]) === TENANT_MIDDLEWARE ? HAND_MOUNTED : undefined;
  const name = origin?.package === TENANCY_HTTP ? ROUTE_DECORATORS.find((n) => n === origin.name) : undefined;
  if (name === undefined) return undefined;
  const reason = name === 'AllTenants' ? literalText(decorator.args[0]) : undefined;
  return reason === undefined ? { declared: name } : { declared: name, reason };
}

/** The first `TenantMiddleware` mount on `node` in source order: at run time the last descriptor wins, and that is the decorator written first. */
function mountOn(node: ts.HasDecorators | undefined, ctx: ExtractorContext): Mount | undefined {
  for (const decorator of node ? decoratorsOf(node) : []) {
    const mount = mountOf(decorator, ctx);
    if (mount) return mount;
  }
  return undefined;
}

/** The controller class and its base classes, nearest first. A base that is only a declaration file is listed and carries no decorator. */
function classChain(cls: ts.ClassDeclaration | undefined, ctx: ExtractorContext): ts.ClassDeclaration[] {
  const out: ts.ClassDeclaration[] = [];
  const symbol = cls?.name && ctx.checker.getSymbolAtLocation(cls.name);
  let current: ts.Type | undefined = symbol ? ctx.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  for (let hops = 0; current && hops < 32; hops++) {
    const declaration = current.getSymbol()?.declarations?.find(ts.isClassDeclaration);
    if (declaration) out.push(declaration);
    current = baseClassOf(ctx.checker, current);
  }
  return out;
}

const methodNamed = (cls: ts.ClassDeclaration, name: string): ts.MethodDeclaration | undefined =>
  cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name);

/** The first of `nodes` that carries a mount. */
function nearestMount(nodes: Array<ts.HasDecorators | undefined>, ctx: ExtractorContext): Mount | undefined {
  for (const node of nodes) {
    const found = mountOn(node, ctx);
    if (found) return found;
  }
  return undefined;
}

/**
 * What TenantMiddleware decides at run time: the nearest mount on the route method up the class chain, else the nearest
 * on a class. A subclass inherits the descriptors of its bases, so a redeclared method without a decorator keeps the
 * base's. A route whose deciding mount is hand-written declares nothing.
 */
function routeDeclarations(controllers: ControllerEntry[], classes: Map<string, ts.ClassDeclaration>, ctx: ExtractorContext): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const controller of controllers) {
    const chain = classChain(classes.get(sourceKey(controller.source)), ctx);
    const ofClass = nearestMount(chain, ctx);
    for (const route of controller.routes) {
      const mount = nearestMount(chain.map((cls) => methodNamed(cls, route.handler)), ctx) ?? ofClass;
      if (mount && mount !== HAND_MOUNTED) out.set(routeEntryId(route), mount);
    }
  }
  return out;
}

function jobDeclaration(cls: ts.ClassDeclaration | undefined, ctx: ExtractorContext): Declaration | undefined {
  const value = cls && literalValue(optionOf(findDecorator(cls, 'Job')?.args[0], 'tenancy'), ctx);
  return value === 'carry' || value === 'required' || value === 'none' ? { declared: value } : undefined;
}

function scheduleDeclarations(schedules: ScheduleEntry[]): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const schedule of schedules) {
    const value = schedule.options.tenancy;
    if (value === 'none' || value === 'each') out.set(schedule.name, { declared: value });
  }
  return out;
}

/** Every entry point the authz section lists, with what it declares. A fragment cannot see a global mount, so an undeclared one is `none`. */
function entryPointsOf(inputs: TenancyInputs, files: readonly ts.SourceFile[], ctx: ExtractorContext): TenancyEntryPoint[] {
  const classes = classesBySource(files, ctx, sourceKey);
  const routes = programDeclares(ctx.program, TENANCY_HTTP) ? routeDeclarations(inputs.controllers, classes, ctx) : new Map<string, Declaration>();
  const schedules = scheduleDeclarations(inputs.schedules);
  const declarationOf = (entry: EntryPoint): Declaration | undefined => {
    if (entry.kind === 'route') return routes.get(entry.id);
    if (entry.kind === 'schedule') return schedules.get(entry.id);
    return entry.kind === 'queue-handler' ? jobDeclaration(classes.get(sourceKey(entry.source)), ctx) : undefined;
  };
  return (inputs.authz?.entryPoints ?? []).map((entry) => {
    const declaration = declarationOf(entry);
    const tenancy = declaration ? DECLARED_ENTRY_TENANCY[declaration.declared] : undeclaredTenancy(entry.kind, false);
    return { kind: entry.kind, id: entry.id, tenancy, ...declaration, source: entry.source };
  });
}

/** The package's `tenancy` section; undefined when it declares no tenant model, entry-point tenancy, escape or ignore. */
export function tenancySectionOf(ctx: ExtractorContext, files: readonly ts.SourceFile[], inputs: TenancyInputs): TenancySection | undefined {
  const section: TenancySection = { models: inputs.models, entryPoints: entryPointsOf(inputs, files, ctx), escapes: escapesIn(files, ctx), ignores: ignoreCommentsIn(files, ctx, IGNORE) };
  const declares = section.models.length > 0 || section.entryPoints.some((e) => e.declared !== undefined) || section.escapes.length > 0 || section.ignores.length > 0;
  return declares ? section : undefined;
}

/** The `tenancy` member of a fragment, to spread into it: `analyzePackage` has no room for another branch. */
export function tenancyOf(ctx: ExtractorContext, files: readonly ts.SourceFile[], inputs: TenancyInputs): Pick<ManifestFragment, 'tenancy'> {
  const tenancy = tenancySectionOf(ctx, files, inputs);
  return tenancy ? { tenancy } : {};
}
