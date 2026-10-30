import ts from 'typescript';
import type { RouteEntry } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';

const text = (c: string | ts.NodeArray<ts.JSDocComment> | undefined): string => (typeof c === 'string' ? c : c ? c.map((p) => p.text).join('') : '').trim();

export function classDocOf(cls: ts.ClassDeclaration): string | undefined {
  const doc = ts.getJSDocCommentsAndTags(cls).find(ts.isJSDoc);
  return (doc ? text(doc.comment) : '') || undefined;
}

type RouteDoc = NonNullable<RouteEntry['doc']>;

function applyTag(doc: RouteDoc, tag: ts.JSDocTag, ctx: ExtractorContext): void {
  const name = tag.tagName.text;
  const body = text(tag.comment);
  if (name === 'summary') doc.summary = body;
  else if (name === 'description') doc.description = body;
  else if (name === 'tags' || name === 'tag' || name === 'category') doc.tags = [...(doc.tags ?? []), ...body.split(/[,\s]+/).filter(Boolean)];
  else if (name === 'deprecated') doc.deprecated = true;
  else if (name === 'response') {
    const m = /^(\d{3})\s*(?:\{([^}]+)\})?\s*(.*)$/.exec(body);
    if (m) doc.responses = [...(doc.responses ?? []), { status: Number(m[1]), ...(m[3] ? { description: m[3] } : {}), ...(m[2] ? { type: { text: m[2] } } : {}) }];
    else ctx.info('CMP002', `unparsable @response tag: ${body}`, tag);
  }
}

export function routeDocOf(method: ts.MethodDeclaration, ctx: ExtractorContext): RouteEntry['doc'] | undefined {
  const doc: RouteDoc = {};
  const jsdoc = ts.getJSDocCommentsAndTags(method).find(ts.isJSDoc);
  if (jsdoc && text(jsdoc.comment)) doc.description = text(jsdoc.comment);
  for (const tag of ts.getJSDocTags(method)) applyTag(doc, tag, ctx);
  return Object.keys(doc).length ? doc : undefined;
}
