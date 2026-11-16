import { isPartial, refsIn, type NamedSchema, type SchemaGraph } from './refs.js';

/** `UserDtoSchema` is read as `UserDtoReply`. */
export const replyName = (name: string): string => `${name.replace(/Schema$/, '')}Reply`;

/** The declared schemas a reply reaches from `roots`, in declaration order: each needs a `Reply` variant. */
export function replyClosure(graph: SchemaGraph, roots: Iterable<string>): NamedSchema[] {
  const seen = new Set<string>();
  const pending = [...roots];
  for (let key = pending.shift(); key !== undefined; key = pending.shift()) {
    const entry = graph.get(key);
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    if (isPartial(entry.schema)) continue;
    pending.push(...refsIn(entry.schema).flatMap((ref) => graph.resolve(ref, entry.owner) ?? []));
  }
  return graph.declarations.filter((entry) => seen.has(entry.key));
}

export const REPLY_RUNTIME = `type ReplyParser = { parse(value: unknown): unknown };

/** The \`parseReply\` of \`createAppClient\`: parses a reply with the schema of its route, and passes through a route without one. */
export function zodReplies(schemas: Record<string, Record<string, ReplyParser>> = replySchemas): (route: { controller: string; name: string }, value: unknown) => unknown {
  return (route, value) => {
    const handlers = Object.prototype.hasOwnProperty.call(schemas, route.controller) ? schemas[route.controller] : undefined;
    const schema = handlers && Object.prototype.hasOwnProperty.call(handlers, route.name) ? handlers[route.name] : undefined;
    return schema ? schema.parse(value) : value;
  };
}`;
