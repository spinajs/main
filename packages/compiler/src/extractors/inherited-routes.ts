import ts from 'typescript';
import { inheritController, type ControllerEntry, type RouteEntry, type SocketControllerEntry, type TypeRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { declarationOf, routeOverridesOf } from './controllers.js';
import { methodTypeOf, nearestAncestor, type Ancestor } from './lineage.js';

export interface ExternalBases {
  controller(decl: ts.ClassDeclaration): ControllerEntry | undefined;
  socketController(decl: ts.ClassDeclaration): SocketControllerEntry | undefined;
}

export const NO_EXTERNAL_BASES: ExternalBases = { controller: () => undefined, socketController: () => undefined };

type NamedClass = ts.ClassDeclaration & { name: ts.Identifier };

// Kinds whose type the framework injects or that carry binary data: `paramOf` derives nothing for them either.
const TYPE_KEPT_KINDS = new Set(['FromFile', 'ArgAsRequest', 'ArgAsResponse', 'FromDi']);

const contractOf = (fields: TypeRef, ref: TypeRef): TypeRef => {
  const { schema: _replaced, ...rest } = ref;
  return { ...rest, text: fields.text, ...(fields.schema ? { schema: fields.schema } : {}) };
};

/**
 * `route` as `sub` sees it. Only the contract types change (`text`, `schema`): `ref`, `kind` and `wire` stay what the
 * declaring class recorded, because decorator metadata and the route-arg conversion are bound where the decorator ran.
 */
export function asSeenBy(route: RouteEntry, sub: NamedClass, declaring: ts.ClassDeclaration, ctx: ExtractorContext): RouteEntry {
  const seen = methodTypeOf(sub, route.handler, ctx.checker);
  if (!seen || seen === methodTypeOf(declaring, route.handler, ctx.checker)) return route;
  const [signature] = seen.getCallSignatures();
  if (!signature) return route;

  const hint = `${sub.name.text}_${route.handler}`;
  const params = route.params.map((p) => {
    const param = signature.parameters[p.index];
    if (!param || TYPE_KEPT_KINDS.has(p.kind)) return p;
    const type = ctx.checker.getNonNullableType(ctx.checker.getTypeOfSymbolAtLocation(param, sub));
    return { ...p, runtimeType: contractOf(ctx.typeRef(type, sub, `${hint}_${p.name}`), p.runtimeType) };
  });
  return { ...route, params, returnType: ctx.typeRef(ctx.checker.getReturnTypeOfSignature(signature), sub, `${hint}_Response`) };
}

/** Every entry with what its ancestors contribute, in input order. Entries are resolved ancestors first, each once. */
export function withInheritedRoutes(entries: ControllerEntry[], ctx: ExtractorContext, external: ExternalBases): ControllerEntry[] {
  const byDeclaration = new Map<ts.ClassDeclaration, ControllerEntry>();
  for (const entry of entries) {
    const declaration = declarationOf(entry);
    if (declaration) byDeclaration.set(declaration, entry);
  }
  const resolved = new Map<ControllerEntry, ControllerEntry>();

  const effective = (entry: ControllerEntry): ControllerEntry => {
    const known = resolved.get(entry);
    if (known) return known;
    const node = declarationOf(entry);
    const ancestor = node && nearestAncestor(node, ctx.checker, (decl) => {
      const local = byDeclaration.get(decl);
      return local ? effective(local) : external.controller(decl);
    });
    const result = node && ancestor ? inheritFrom(entry, node, ancestor, ctx) : entry;
    resolved.set(entry, result);
    return result;
  };
  return entries.map(effective);
}

function inheritFrom(own: ControllerEntry, node: NamedClass, ancestor: Ancestor<ControllerEntry>, ctx: ExtractorContext): ControllerEntry {
  const seen = { ...ancestor.entry, routes: ancestor.entry.routes.map((r) => asSeenBy(r, node, ancestor.declaration, ctx)) };
  const mountPath = own.basePath !== null ? (own.mountPath ?? own.basePath) : seen.basePath !== null ? (seen.mountPath ?? seen.basePath) : own.className.toLowerCase();
  return inheritController(seen, own, routeOverridesOf(node, seen, mountPath, ctx));
}
