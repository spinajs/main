import { Node, SyntaxKind, type ClassDeclaration, type ClassExpression } from 'ts-morph';
import type { Transform } from '../index.js';
import { insertNotes } from './notes.js';

const SERVER_DOC = 'docs/http/15-server-middlewares.md#migrating-from-before-and-after';
const ROUTE_DOC = 'docs/http/14-route-middlewares.md#migrating-from-the-positional-hooks';

export const SERVER_HOOKS_NOTE = `// TODO(spinajs-4): before()/after() are removed, use onBefore(ctx), onAfter(ctx), onFinish(ctx) or handler(), see ${SERVER_DOC}`;
export const TAIL_HOOKS_NOTE = `// TODO(spinajs-4): before()/after() are removed, override reply() and return the Response, see ${SERVER_DOC}`;
export const ROUTE_HOOKS_NOTE = `// TODO(spinajs-4): route middleware hooks take one context, onBefore(ctx) / onAfter(ctx), see ${ROUTE_DOC}`;
export const ON_RESPONSE_NOTE = `// TODO(spinajs-4): onResponse is removed, move it to onAfter(ctx) (the reply is ctx.response), see ${ROUTE_DOC}`;

type Kind = 'server' | 'tail' | 'route';

const BASES = new Map<string, Kind>([
  ['ServerMiddleware', 'server'],
  ['NotFoundMiddleware', 'tail'],
  ['ErrorHandlerMiddleware', 'tail'],
  ['RouteMiddleware', 'route'],
]);

type AnyClass = ClassDeclaration | ClassExpression;

/** The middleware base the class extends, directly or through classes the project resolves; matched by name. */
function middlewareKind(cls: AnyClass): Kind | undefined {
  const seen = new Set<AnyClass>();
  for (let current: AnyClass | undefined = cls; current && !seen.has(current); current = current.getBaseClass()) {
    seen.add(current);
    const base = current.getExtends()?.getExpression();
    const name = Node.isIdentifier(base) ? base.getText() : Node.isPropertyAccessExpression(base) ? base.getName() : undefined;
    const kind = name ? BASES.get(name) : undefined;
    if (kind) return kind;
  }
  return undefined;
}

function noteFor(kind: Kind, member: string, parameters: number): string | undefined {
  const legacy = member === 'before' || member === 'after';
  if (kind === 'server' && legacy) return SERVER_HOOKS_NOTE;
  if (kind === 'tail' && legacy) return TAIL_HOOKS_NOTE;
  if (kind === 'route' && member === 'onResponse') return ON_RESPONSE_NOTE;
  if (kind === 'route' && (member === 'onBefore' || member === 'onAfter') && parameters > 1) return ROUTE_HOOKS_NOTE;
  return undefined;
}

function parameterCount(member: Node): number {
  if (Node.isMethodDeclaration(member)) return member.getParameters().length;
  const init = Node.isPropertyDeclaration(member) ? member.getInitializer() : undefined;
  return Node.isArrowFunction(init) || Node.isFunctionExpression(init) ? init.getParameters().length : 0;
}

export const httpMiddlewareHooks: Transform = {
  name: 'http-middleware-hooks',
  description: 'Adds a TODO above middleware hooks 4.0 removed or changed: before()/after() of server middlewares, onResponse and positional onBefore/onAfter of route middlewares',
  apply(_project, file) {
    const notes: Array<{ node: Node; note: string }> = [];
    const classes = [...file.getDescendantsOfKind(SyntaxKind.ClassDeclaration), ...file.getDescendantsOfKind(SyntaxKind.ClassExpression)];
    for (const cls of classes) {
      const kind = middlewareKind(cls);
      if (!kind) continue;
      for (const member of cls.getMembers()) {
        if (!Node.isMethodDeclaration(member) && !Node.isPropertyDeclaration(member)) continue;
        if (member.isStatic()) continue;
        const note = noteFor(kind, member.getName(), parameterCount(member));
        if (note) notes.push({ node: member, note });
      }
    }
    return insertNotes(file, notes);
  },
};
