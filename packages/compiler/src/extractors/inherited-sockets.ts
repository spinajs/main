import ts from 'typescript';
import { inheritSocketHandlers, type SocketCommandEntry, type SocketControllerEntry, type SocketEventEntry, type TypeRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { contractOf, type ExternalBases } from './inherited-routes.js';
import { methodTypeOf, nearestAncestor, type Ancestor } from './lineage.js';
import { socketDeclarationOf, streamItemOf } from './socket.js';

type NamedClass = ts.ClassDeclaration & { name: ts.Identifier };

/** The handler's signature as `sub` sees it, when that differs from the declaring class's view. */
function signatureSeenBy(handler: string, sub: NamedClass, declaring: ts.ClassDeclaration, ctx: ExtractorContext): ts.Signature | undefined {
  const seen = methodTypeOf(sub, handler, ctx.checker);
  return seen && seen !== methodTypeOf(declaring, handler, ctx.checker) ? seen.getCallSignatures()[0] : undefined;
}

/** Only the contract types (`text`, `schema`) change: `ref` stays where the `@Payload` decorator ran. */
function payloadSeenBy(entry: { payload: TypeRef; payloadIndex?: number }, signature: ts.Signature, sub: NamedClass, hint: string, ctx: ExtractorContext): TypeRef {
  const param = entry.payloadIndex !== undefined ? signature.parameters[entry.payloadIndex] : undefined;
  return param ? contractOf(ctx.typeRef(ctx.checker.getTypeOfSymbolAtLocation(param, sub), sub, `${hint}_Payload`), entry.payload) : entry.payload;
}

function commandSeenBy(c: SocketCommandEntry, sub: NamedClass, declaring: ts.ClassDeclaration, ctx: ExtractorContext): SocketCommandEntry {
  const signature = signatureSeenBy(c.handler, sub, declaring, ctx);
  if (!signature) return c;
  const hint = `${sub.name.text}_${c.handler}`;
  const returned = ctx.checker.getReturnTypeOfSignature(signature);
  // A streamed command records the item type, as the extractor does for its own commands.
  const item = c.stream ? streamItemOf(returned, ctx) : returned;
  const result = item ? ctx.typeRef(item, sub, `${hint}_Result`) : c.result;
  return { ...c, payload: payloadSeenBy(c, signature, sub, hint, ctx), result };
}

function eventSeenBy(e: SocketEventEntry, sub: NamedClass, declaring: ts.ClassDeclaration, ctx: ExtractorContext): SocketEventEntry {
  const signature = e.handler && signatureSeenBy(e.handler, sub, declaring, ctx);
  return signature ? { ...e, payload: payloadSeenBy(e, signature, sub, `${sub.name.text}_${e.handler}`, ctx) } : e;
}

function inheritFrom(own: SocketControllerEntry, node: NamedClass, ancestor: Ancestor<SocketControllerEntry>, ctx: ExtractorContext): SocketControllerEntry {
  const base = ancestor.entry;
  const seen = {
    ...base,
    commands: base.commands.map((c) => commandSeenBy(c, node, ancestor.declaration, ctx)),
    events: base.events.map((e) => eventSeenBy(e, node, ancestor.declaration, ctx)),
  };
  return { ...inheritSocketHandlers(own, [seen]), bases: [base.id, ...(base.bases ?? [])] };
}

/** Every socket entry with the handlers its ancestors contribute, in input order. Entries are resolved ancestors first, each once. */
export function withInheritedHandlers(entries: SocketControllerEntry[], ctx: ExtractorContext, external: ExternalBases): SocketControllerEntry[] {
  const byDeclaration = new Map<ts.ClassDeclaration, SocketControllerEntry>();
  for (const entry of entries) {
    const declaration = socketDeclarationOf(entry);
    if (declaration) byDeclaration.set(declaration, entry);
  }
  const resolved = new Map<SocketControllerEntry, SocketControllerEntry>();

  const effective = (entry: SocketControllerEntry): SocketControllerEntry => {
    const known = resolved.get(entry);
    if (known) return known;
    const node = socketDeclarationOf(entry);
    const ancestor = node && nearestAncestor(node, ctx.checker, (decl) => {
      const local = byDeclaration.get(decl);
      return local ? effective(local) : external.socketController(decl);
    });
    const result = node && ancestor ? inheritFrom(entry, node, ancestor, ctx) : entry;
    resolved.set(entry, result);
    return result;
  };
  return entries.map(effective);
}
