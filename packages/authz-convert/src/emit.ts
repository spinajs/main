import type { Finding, Severity } from './findings.js';
import { isPlain } from './values.js';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const INLINE_WIDTH = 100;

// Line terminators, backslash and the quote; the rest of a string is safe inside single quotes.
const BACKSLASH = String.fromCharCode(0x5c);
const ESCAPES: Record<number, string> = { 0x5c: BACKSLASH + BACKSLASH, 0x27: `${BACKSLASH}'`, 0x0a: `${BACKSLASH}n`, 0x0d: `${BACKSLASH}r`, 0x2028: `${BACKSLASH}u2028`, 0x2029: `${BACKSLASH}u2029` };
const isLoneSurrogate = (c: string) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff;
// Code points, so a surrogate pair stays whole; a lone surrogate would turn into U+FFFD when the file is written.
const quote = (s: string): string => `'${[...s].map((c) => (isLoneSurrogate(c) ? `${BACKSLASH}u${c.charCodeAt(0).toString(16)}` : (ESCAPES[c.charCodeAt(0)] ?? c))).join('')}'`;
const key = (k: string): string => (IDENT.test(k) ? k : quote(k));

function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (isPlain(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, x]) => `${key(k)}: ${inline(x)}`).join(', ')} }`;
  }
  if (typeof v === 'string') return quote(v);
  if (v === null) return 'null';
  return String(v);
}

/** A TypeScript literal of plain data; a container goes on one line when it fits and holds no nested object. */
export function literal(v: unknown, indent = ''): string {
  const flat = inline(v);
  const nested = Array.isArray(v) ? v.some((x) => isPlain(x) && Object.keys(x).length > 2) : isPlain(v) && Object.values(v).some((x) => isPlain(x) || (Array.isArray(x) && x.some(isPlain)));
  if ((!Array.isArray(v) && !isPlain(v)) || (flat.length + indent.length <= INLINE_WIDTH && !nested)) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((x) => `${inner}${literal(x, inner)},`).join('\n')}\n${indent}]`;
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return entries.length === 0 ? '{}' : `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${literal(x, inner)},`).join('\n')}\n${indent}}`;
}

export function configModule(value: unknown, header: readonly string[]): string {
  const lines = header.map((l) => `// ${[...l].map((c) => ([0x0a, 0x0d, 0x2028, 0x2029].includes(c.charCodeAt(0)) ? ' ' : c)).join('')}`);
  return `${lines.join('\n')}\nexport default ${literal(value)};\n`;
}

const SECTIONS: readonly [Severity, string, string][] = [
  ['manual', 'Convert by hand', 'The converter left these out (or wrote them as found) because it cannot convert them without guessing. Boot may fail until they are done.'],
  ['warning', 'Behaviour changes and actions', 'Converted, but 3.0 behaves differently here, or the app must act.'],
  ['info', 'Notes', 'Converted as the migration guide describes.'],
];

export function warningsMarkdown(findings: readonly Finding[], intro: readonly string[]): string {
  const lines = ['# spinajs-authz-convert warnings', '', ...intro, ''];
  for (const [severity, title, about] of SECTIONS) {
    const list = findings.filter((x) => x.severity === severity);
    lines.push(`## ${title} (${list.length})`, '', about, '');
    if (list.length === 0) lines.push('None.', '');
    for (const x of list) lines.push(`- [${x.layer ?? 'common'}] ${x.path ? `\`${x.path}\`: ` : ''}${x.message} (${x.code})`);
    if (list.length > 0) lines.push('');
  }
  return lines.join('\n');
}
