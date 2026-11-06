import { GLOBAL_TYPE } from '../ir.js';
import type { CaveatDef, PermissionBinding, PolicyIR, RelationDef, Rewrite, SubjectTypeRef, TypeDef } from '../ir.js';
import { OPENFGA_GLOBAL } from './openfga-write.js';

const DEFAULT_SOURCE: RelationDef['source'] = Object.freeze({ kind: 'tuples', store: 'authz_rebac_tuple' });

export class OpenFgaParseError extends Error {}

interface Parsed {
  allowed?: SubjectTypeRef[];
  rewrite?: Rewrite;
}

/**
 * The IR of an OpenFGA model (schema 1.1): types, relations (`[...]` type restrictions, `x from y`, `or`, `and`,
 * `but not`) and the `# spina:` comments `writeOpenFga` adds, which restore relation sources, permission
 * bindings, combine, principal narrowing, opaque refs, caveats and the rewrites behind stand-ins. A `condition` block
 * without its `# spina:caveat` comment is refused: the IR does not read CEL.
 */
export function readOpenFga(dsl: string): PolicyIR {
  const reader = new Reader();
  dsl.split(/\r?\n/).forEach((raw, index) => reader.line(raw, `line ${index + 1}`));
  return reader.finish();
}

class Reader {
  readonly ir: PolicyIR = { version: 1, types: {}, permissions: {}, caveats: {}, combine: { default: { algorithm: 'deny-overrides' } }, principal: { ceiling: true, delegation: true, ancestry: 'parent', roles: {} }, opaque: [] };
  // Relations wait for every type, so `global` can be told from `$global`.
  private readonly pending: Array<() => void> = [];
  private current?: TypeDef;
  private inCondition = false;

  line(raw: string, at: string): void {
    const [code, comment] = splitComment(raw);
    const line = code.trim();
    if (this.inCondition) {
      this.inCondition = line !== '}';
      return;
    }
    if (line === '' && comment !== undefined) return meta(this.ir, comment, at);
    if (line === '' || line === 'model' || /^schema\s+1\.1$/.test(line) || line === 'relations') return;
    const type = /^type\s+(\S+)$/.exec(line);
    if (type) return this.type(type[1], comment);
    const condition = /^condition\s+([^\s(]+)\s*\(/.exec(line);
    if (condition) {
      if (!Object.prototype.hasOwnProperty.call(this.ir.caveats, condition[1])) throw new OpenFgaParseError(`${at}: condition ${condition[1]} has no # spina:caveat comment; CEL conditions are not imported`);
      this.inCondition = true;
      return;
    }
    const define = /^define\s+([^\s:]+)\s*:\s*(.+)$/.exec(line);
    if (!define || this.current === undefined) throw new OpenFgaParseError(`${at}: cannot read ${JSON.stringify(line)}`);
    this.define(this.current, define[1], define[2], comment, at);
  }

  finish(): PolicyIR {
    for (const add of this.pending) add();
    return this.ir;
  }

  private type(name: string, comment: string | undefined): void {
    if (comment === 'spina:implicit') {
      this.current = undefined;
      return;
    }
    const key = comment === 'spina:$global' ? GLOBAL_TYPE : name;
    this.current = this.ir.types[key] = { relations: {}, permissions: {} };
  }

  private define(def: TypeDef, name: string, expression: string, comment: string | undefined, at: string): void {
    if (comment?.startsWith('spina:rewrite ') === true) {
      const { rewrite, relation } = json(comment.slice('spina:rewrite '.length), at) as { rewrite: Rewrite; relation?: RelationDef };
      def.permissions[name] = rewrite;
      if (relation !== undefined) def.relations[name] = relation;
      return;
    }
    const parsed = parseExpression(expression, at);
    const source = comment === undefined ? DEFAULT_SOURCE : sourceOf(comment, at);
    const typeOf = (t: string): string => (t === OPENFGA_GLOBAL && Object.prototype.hasOwnProperty.call(this.ir.types, GLOBAL_TYPE) ? GLOBAL_TYPE : t);
    this.pending.push(() => addDefine(def, name, parsed, source, typeOf));
  }
}

function addDefine(def: TypeDef, name: string, parsed: Parsed, source: RelationDef['source'], typeOf: (n: string) => string): void {
  if (parsed.allowed !== undefined) def.relations[name] = { allowed: parsed.allowed.map((a) => mapType(a, typeOf)), source };
  if (parsed.rewrite !== undefined) def.permissions[name] = parsed.rewrite;
}

function mapType(a: SubjectTypeRef, typeOf: (n: string) => string): SubjectTypeRef {
  const text = typeof a === 'string' ? a : a.type;
  const m = /^([^#:]+)(.*)$/.exec(text)!;
  const mapped = `${typeOf(m[1])}${m[2]}`;
  return typeof a === 'string' ? mapped : { type: mapped, caveat: a.caveat };
}

/** A comment starts at a '#' after whitespace or at the line start; the one in `group#member` does not. */
function splitComment(raw: string): [string, string | undefined] {
  const m = /(^|\s)#(.*)$/.exec(raw);
  return m === null ? [raw, undefined] : [raw.slice(0, m.index + m[1].length), m[2].trim()];
}

function meta(ir: PolicyIR, comment: string, at: string): void {
  const m = /^spina:(\S+)\s+(.*)$/.exec(comment);
  if (!m) return;
  const [, kind, rest] = m;
  const named = (): [string, unknown] => {
    const space = rest.indexOf(' ');
    if (space < 0) throw new OpenFgaParseError(`${at}: # spina:${kind} needs a name and JSON`);
    return [rest.slice(0, space), json(rest.slice(space + 1), at)];
  };
  if (kind === 'ir') {
    const v = json(rest, at) as Pick<PolicyIR, 'combine' | 'principal' | 'opaque'>;
    Object.assign(ir, { combine: v.combine, principal: v.principal, opaque: v.opaque });
  } else if (kind === 'permission') {
    const [name, v] = named();
    ir.permissions[name] = v as PermissionBinding;
  } else if (kind === 'caveat') {
    const [name, v] = named();
    ir.caveats[name] = v as CaveatDef;
  }
}

function json(text: string, at: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenFgaParseError(`${at}: a # spina: comment carries malformed JSON`);
  }
}

function sourceOf(comment: string, at: string): RelationDef['source'] {
  const m = /^spina:(tuples|column|ancestor|self)\s*(\{.*\})?$/.exec(comment);
  if (!m) return DEFAULT_SOURCE;
  try {
    return { kind: m[1], ...(JSON.parse(m[2] ?? '{}') as object) } as RelationDef['source'];
  } catch {
    throw new OpenFgaParseError(`${at}: # spina:${m[1]} carries malformed JSON`);
  }
}

// ---- expressions ----

type Token = { t: 'word' | 'punct'; v: string };

function tokenize(text: string, at: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(\(|\)|\[|\]|,|[^\s()[\],]+)/y;
  let m: RegExpExecArray | null;
  let i = 0;
  while (i < text.length && (m = re.exec(text)) !== null) {
    out.push({ t: /^[()[\],]$/.test(m[1]) ? 'punct' : 'word', v: m[1] });
    i = re.lastIndex;
  }
  if (text.slice(i).trim() !== '') throw new OpenFgaParseError(`${at}: cannot read ${JSON.stringify(text.slice(i))}`);
  return out;
}

/** `[...]` alone is a stored relation; anything else is a rewrite, with `[...]` read as `this`. */
function parseExpression(text: string, at: string): Parsed {
  const tokens = tokenize(text, at);
  const out: Parsed = {};
  let pos = 0;
  const peek = (): string | undefined => tokens[pos]?.v;
  const take = (v?: string): string => {
    const tok = tokens[pos++];
    if (tok === undefined || (v !== undefined && tok.v !== v)) throw new OpenFgaParseError(`${at}: expected ${v ?? 'a term'} in ${JSON.stringify(text)}`);
    return tok.v;
  };
  const term = (): Rewrite => {
    if (peek() === '(') {
      take('(');
      const r = expr();
      take(')');
      return r;
    }
    if (peek() === '[') {
      take('[');
      const allowed: SubjectTypeRef[] = [];
      while (peek() !== ']') {
        const type = take();
        if (peek() === 'with') {
          take('with');
          allowed.push({ type, caveat: take() });
        } else allowed.push(type);
        if (peek() === ',') take(',');
      }
      take(']');
      out.allowed = allowed;
      return { this: true };
    }
    const name = take();
    if (peek() === 'from') {
      take('from');
      return { tupleToUserset: { tupleset: take(), computed: name } };
    }
    return { computed: name };
  };
  const expr = (): Rewrite => {
    const first = term();
    const op = peek();
    if (op === 'but') {
      take('but');
      take('not');
      return { exclusion: { base: first, subtract: term() } };
    }
    if (op !== 'or' && op !== 'and') return first;
    const items = [first];
    while (peek() === op) {
      take(op);
      items.push(term());
    }
    return op === 'or' ? { union: items } : { intersection: items };
  };
  const rewrite = expr();
  if (pos < tokens.length) throw new OpenFgaParseError(`${at}: unexpected ${JSON.stringify(peek())} in ${JSON.stringify(text)}`);
  if (!('this' in rewrite)) out.rewrite = rewrite;
  return out;
}
