import ts from 'typescript';
import type { DeriveContext, JsonSchema } from './derive.js';

export const NUMERIC_TAGS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const;
export const STRING_TAGS = ['pattern', 'format', 'title'] as const;
export const JSON_TAGS = ['default', 'example'] as const;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function applyTag(out: JsonSchema, name: string, text: string): void {
  if ((NUMERIC_TAGS as readonly string[]).includes(name)) {
    const value = Number(text);
    if (text !== '' && !Number.isNaN(value)) out[name] = value;
  } else if ((STRING_TAGS as readonly string[]).includes(name)) {
    out[name] = text;
  } else if (name === 'default') {
    out.default = parseJson(text);
  } else if (name === 'example') {
    out.examples = [...((out.examples as unknown[] | undefined) ?? []), parseJson(text)];
  } else if (name === 'uniqueItems') {
    out.uniqueItems = text !== 'false';
  } else if (name === 'deprecated') {
    out.deprecated = true;
  }
}

export function jsdocConstraints(ctx: DeriveContext, symbol: ts.Symbol, declaration: ts.Node | undefined): JsonSchema {
  const out: JsonSchema = {};
  const description = ts.displayPartsToString(symbol.getDocumentationComment(ctx.checker)).trim();
  if (description) out.description = description;
  if (!declaration) return out;
  for (const tag of ts.getJSDocTags(declaration)) {
    applyTag(out, tag.tagName.text, (ts.getTextOfJSDocComment(tag.comment) ?? '').trim());
  }
  return out;
}
