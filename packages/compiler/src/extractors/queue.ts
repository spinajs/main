import ts from 'typescript';
import type { QueueMessageEntry } from '@spinajs/manifest';
import type { Extractor } from '../context.js';
import { findDecorator, literalValue } from '../decorators.js';

export const extractQueueMessages: Extractor<QueueMessageEntry> = (ctx, file) => {
  const out: QueueMessageEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const job = findDecorator(st, 'Job');
    const d = job ?? findDecorator(st, 'Event');
    if (!d) continue;
    out.push({
      className: st.name.text,
      kind: job ? 'job' : 'event',
      payload: ctx.typeRef(ctx.checker.getTypeAtLocation(st), st),
      options: (literalValue(d.args[0], ctx) ?? {}) as Record<string, unknown>,
      source: ctx.sourceRef(st),
    });
  }
  return out;
};
