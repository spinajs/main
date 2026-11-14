import ts from 'typescript';
import type { AuthzSection, CliCommandEntry, ControllerEntry, PolicyRef, ScheduleEntry, SocketControllerEntry, SourceRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { findDecorator, identifierName, literalValue } from '../decorators.js';
import { extendsFrameworkClass } from '../schema/framework-members.js';
import { isAbstractClass } from './abstract.js';

type EntryPoint = AuthzSection['entryPoints'][number];
type Resource = AuthzSection['resources'][number];

export interface AuthzInputs {
  controllers: ControllerEntry[];
  socketControllers: SocketControllerEntry[];
  schedules: ScheduleEntry[];
  commands: CliCommandEntry[];
  resources: Resource[];
}

const RESOURCE_ACTIONS = ['read', 'create', 'update', 'delete'];
const IGNORE = /\/\/\s*spinajs-authz-ignore\s+(AUTHZ\d{3})\s*:\s*(.*\S)/g;

/** Class and handler scopes are ANDed at runtime (`createPolicyGate`); as OR-of-AND groups that is their cross product. */
export function combineScopes(outer: PolicyRef[][], inner: PolicyRef[][]): PolicyRef[][] {
  if (outer.length === 0) return inner;
  if (inner.length === 0) return outer;
  return outer.flatMap((o) => inner.map((i) => [...o, ...i]));
}

/** The extractors record `AccessPolicy` with its scope as the option; here it carries the permissions instead. */
function withPermissions(groups: PolicyRef[][], permissions: { class?: string[]; route?: string[] }): PolicyRef[][] {
  return groups.map((group) =>
    group.map((ref) => {
      const scope = ref.options?.[0];
      if (ref.type !== 'AccessPolicy' || (scope !== 'class' && scope !== 'route')) return ref;
      return { type: ref.type, options: permissions[scope] ?? [] };
    }),
  );
}

const sourceKey = (s: SourceRef): string => `${s.file}:${s.line}:${s.col}`;

function routeEntryPoints(controllers: ControllerEntry[]): EntryPoint[] {
  return controllers.flatMap((c) =>
    c.routes.map((r) => ({
      kind: 'route' as const,
      id: `${r.method.toUpperCase()} ${r.fullPath}`,
      access: withPermissions(combineScopes(c.policies, r.policies), { class: c.access, route: r.access }),
      source: r.source,
    })),
  );
}

function socketEntryPoints(controllers: SocketControllerEntry[]): EntryPoint[] {
  return controllers.flatMap((c) => {
    const fullName = (name: string): string => (c.prefix ? `${c.prefix}.${name}` : name);
    const access = (handler: { access?: string[]; policies?: PolicyRef[][] }): PolicyRef[][] =>
      withPermissions(combineScopes(c.policies ?? [], handler.policies ?? []), { class: c.access, route: handler.access });
    return [
      ...c.commands.map((cmd) => ({ kind: 'socket-command' as const, id: fullName(cmd.name), access: access(cmd), source: cmd.source })),
      ...c.events.map((ev) => ({ kind: 'socket-event' as const, id: fullName(ev.name), access: access(ev), source: c.source })),
    ];
  });
}

/** `@SystemTask(reason)` by the source of the class it decorates. */
function systemTasks(files: readonly ts.SourceFile[], ctx: ExtractorContext): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of files.flatMap((f) => f.statements)) {
    const reason = ts.isClassDeclaration(st) ? literalValue(findDecorator(st, 'SystemTask')?.args[0], ctx) : undefined;
    if (typeof reason === 'string') out.set(sourceKey(ctx.sourceRef(st)), reason);
  }
  return out;
}

const accessFromOptions = (value: unknown): PolicyRef[][] => {
  const permissions = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
  return permissions.length ? [[{ type: 'AccessPolicy', options: permissions }]] : [];
};

function systemEntry(kind: EntryPoint['kind'], id: string, source: SourceRef, system: Map<string, string>, access: PolicyRef[][] = []): EntryPoint {
  const reason = system.get(sourceKey(source));
  return { kind, id, access, ...(reason !== undefined ? { system: reason } : {}), source };
}

function jobEntryPoint(st: ts.Statement, ctx: ExtractorContext, system: Map<string, string>): EntryPoint | undefined {
  if (!ts.isClassDeclaration(st) || !st.name || isAbstractClass(st) || !ctx.isSubclassOf(st, 'QueueJob')) return undefined;
  const options = literalValue(findDecorator(st, 'Job')?.args[0], ctx) as { access?: unknown } | undefined;
  return systemEntry('queue-handler', `job:${st.name.text}`, ctx.sourceRef(st), system, accessFromOptions(options?.access));
}

function isConsumeCall(node: ts.Node, ctx: ExtractorContext): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'consume' || node.arguments.length < 2) return false;
  return extendsFrameworkClass(ctx.checker, ctx.checker.getTypeAtLocation(node.expression.expression), 'QueueService', '@spinajs/queue');
}

/** `QueueJob` subclasses run `execute`; an event runs the callback a literal `consume(Event, handler)` call passes. */
function queueEntryPoints(files: readonly ts.SourceFile[], ctx: ExtractorContext, system: Map<string, string>): EntryPoint[] {
  const out: EntryPoint[] = files.flatMap((f) => f.statements.flatMap((st) => jobEntryPoint(st, ctx, system) ?? []));
  const visit = (node: ts.Node): void => {
    const message = isConsumeCall(node, ctx) ? identifierName(node.arguments[0]) : undefined;
    const id = message && `event:${message}`;
    if (id && !out.some((e) => e.id === id || e.id === `job:${message}`)) out.push({ kind: 'queue-handler', id, access: [], source: ctx.sourceRef(node) });
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return out;
}

function ignoresIn(files: readonly ts.SourceFile[], ctx: ExtractorContext): AuthzSection['ignores'] {
  return files.flatMap((file) =>
    [...file.text.matchAll(IGNORE)].map((m) => {
      const { line, character } = file.getLineAndCharacterOfPosition(m.index);
      return { code: m[1], reason: m[2], source: { ...ctx.sourceRef(file), line: line + 1, col: character + 1 } };
    }),
  );
}

/** What authz-orm's adapter registers for every resource type at runtime. */
function modelPermissions(resources: Resource[]): AuthzSection['permissions'] {
  const types = [...new Set(resources.map((r) => r.type))];
  return types.flatMap((type) => RESOURCE_ACTIONS.map((action) => ({ name: `${type}:${action}`, declaredIn: 'model' as const })));
}

/** The package's `authz` section; undefined when it declares nothing. `findings` stay empty until the flow pass. */
export function authzSectionOf(ctx: ExtractorContext, files: readonly ts.SourceFile[], inputs: AuthzInputs): AuthzSection | undefined {
  const system = systemTasks(files, ctx);
  const entryPoints = [
    ...routeEntryPoints(inputs.controllers),
    ...socketEntryPoints(inputs.socketControllers),
    ...queueEntryPoints(files, ctx, system),
    ...inputs.schedules.map((s) => systemEntry('schedule', s.name, s.source, system)),
    ...inputs.commands.map((c) => systemEntry('cli', c.name, c.source, system)),
  ];
  const section: AuthzSection = { resources: inputs.resources, permissions: modelPermissions(inputs.resources), entryPoints, findings: [], ignores: ignoresIn(files, ctx) };
  return section.resources.length || section.entryPoints.length || section.ignores.length ? section : undefined;
}
