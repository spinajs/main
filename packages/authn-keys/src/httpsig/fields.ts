// The RFC 8941 structured-field subset RFC 9421 signatures and RFC 9530 digests need, parsed strictly: one canonical
// text form per value, so the signature base can use the Signature-Input text exactly as sent.

const KEY = /^[a-z*][a-z0-9_\-.*]*$/;
const MAX_KEY = 64;
const INTEGER = /^-?[0-9]{1,15}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type ParamValue = number | string;

export interface SignatureInput {
  readonly label: string;
  readonly components: readonly string[];
  readonly params: ReadonlyMap<string, ParamValue>;
  /** The member value as sent; it is the `@signature-params` line of the signature base. */
  readonly value: string;
}

/** An sf-string at `s[i]` (which must be '"'): its value and the index after it, or null. */
function readString(s: string, i: number): { value: string; end: number } | null {
  let value = '';
  for (let j = i + 1; j < s.length; j += 1) {
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      if (n !== '"' && n !== '\\') {
        return null;
      }
      value += n;
      j += 1;
    } else if (c === '"') {
      return { value, end: j + 1 };
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) {
        return null;
      }
      value += c;
    }
  }
  return null;
}

const serializeString = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A dictionary key ending at the first '=' from `i`, or null. */
function readKey(s: string, i: number): { key: string; end: number } | null {
  const eq = s.indexOf('=', i);
  const key = eq < 0 ? '' : s.slice(i, eq);
  return KEY.test(key) && key.length <= MAX_KEY ? { key, end: eq + 1 } : null;
}

/**
 * `Signature-Input` with exactly one member: `<label>=("<component>" …);<name>=<integer or string>…`. Component
 * names carry no parameters; parameter values are integers or strings. Null for anything else, a second member,
 * a duplicate parameter or component, or text that is not in canonical form.
 */
export function parseSignatureInput(header: unknown): SignatureInput | null {
  if (typeof header !== 'string') {
    return null;
  }
  const s = header.trim();
  const key = readKey(s, 0);
  if (!key || s[key.end] !== '(') {
    return null;
  }
  const components: string[] = [];
  let i = key.end + 1;
  while (s[i] !== ')') {
    if (components.length > 0) {
      if (s[i] !== ' ') {
        return null;
      }
      i += 1;
    }
    if (s[i] !== '"') {
      return null;
    }
    const str = readString(s, i);
    if (!str || str.value.length === 0 || components.includes(str.value)) {
      return null;
    }
    components.push(str.value);
    i = str.end;
  }
  i += 1;
  const params = new Map<string, ParamValue>();
  while (i < s.length) {
    if (s[i] !== ';') {
      return null;
    }
    const name = readKey(s, i + 1);
    if (!name || params.has(name.key)) {
      return null;
    }
    i = name.end;
    if (s[i] === '"') {
      const str = readString(s, i);
      if (!str) {
        return null;
      }
      params.set(name.key, str.value);
      i = str.end;
    } else {
      const m = /^-?[0-9]+/.exec(s.slice(i));
      if (!m || !INTEGER.test(m[0]) || (m[0].length > 1 && /^-?0/.test(m[0]))) {
        return null;
      }
      params.set(name.key, Number(m[0]));
      i += m[0].length;
    }
  }
  const value = s.slice(key.end);
  const canonical = `(${components.map(serializeString).join(' ')})${[...params].map(([k, v]) => `;${k}=${typeof v === 'number' ? v : serializeString(v)}`).join('')}`;
  return canonical === value ? { label: key.key, components, params, value } : null;
}

/** RFC 8941 byte sequence in standard base64, canonical (padded, no stray bits). */
function decodeByteSequence(text: string): Buffer | null {
  if (!BASE64.test(text) || text.length % 4 !== 0) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

/** A dictionary whose members are all byte sequences (`Signature`, `Content-Digest`); null when not exactly that. */
export function parseByteSequenceDictionary(header: unknown): Map<string, Buffer> | null {
  if (typeof header !== 'string') {
    return null;
  }
  const out = new Map<string, Buffer>();
  for (const member of header.split(',')) {
    const m = member.trim();
    const key = readKey(m, 0);
    if (!key || out.has(key.key) || m[key.end] !== ':' || !m.endsWith(':') || m.length < key.end + 2) {
      return null;
    }
    const bytes = decodeByteSequence(m.slice(key.end + 1, -1));
    if (!bytes) {
      return null;
    }
    out.set(key.key, bytes);
  }
  return out.size > 0 ? out : null;
}
