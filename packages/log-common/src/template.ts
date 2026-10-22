// JSON.stringify leaves U+007F-U+009F, Unicode line breaks and direction marks as they are, and a text target's layout
// expands a `${name}` that a value brings into the message.
const UNSAFE = /[$\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PLAIN = /^[\p{L}\p{N}_.,:;/\\+@#~*!?&|()[\]<>'-]+$/u;

const has = (fields: Record<string, unknown>, name: string): boolean => {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) {
    return false;
  }
  const v = fields[name];
  return v !== undefined && v !== null && v !== "";
};

const escape = (s: string): string => s.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function json(v: object): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

/**
 * Renders one field value for a log line: a plain token as it is, an object or array as JSON, anything else quoted.
 * All of it escaped, so a value can forge neither a field nor a line.
 */
export function renderValue(v: unknown): string {
  if (v instanceof Date && Number.isFinite(v.getTime())) {
    return v.toISOString();
  }
  if (v instanceof Error) {
    return renderValue(v.message);
  }
  if (typeof v === "object" && v !== null && !(v instanceof Date)) {
    // A luxon DateTime and the like serialize to a plain string, which reads better as one than as quoted JSON.
    const j = json(v);
    if (j !== undefined && j.startsWith('"')) {
      return renderValue(JSON.parse(j) as string);
    }
    if (j !== undefined) {
      return escape(j);
    }
  }
  const s = typeof v === "function" ? "" : String(v);
  return PLAIN.test(s) ? s : escape(JSON.stringify(s));
}

/**
 * Renders the message template of a merging-object call ( `log.info(fields, template, ...args)` ) against that call's
 * fields only: `${name}` takes the field through {@link renderValue}, `${?name}...${/name}` keeps its body only when
 * the field is set. A name the call does not pass renders as absent, so ambient context or logger variables cannot
 * fill it. `${name:option}` is left to the target layout.
 *
 * `escapePercent` doubles a `%` in values, for a template that printf args are formatted into afterwards.
 */
export function renderTemplate(template: string, fields: Record<string, unknown>, escapePercent = false): string {
  if (!template.includes("${")) {
    return template;
  }
  const kept = replaceConditionals(template, (name, body) => (has(fields, name) ? body : ""));
  return replacePlaceholders(kept, (name) => {
    if (!has(fields, name)) {
      return "";
    }
    const s = renderValue(fields[name]);
    return escapePercent ? s.replace(/%/g, "%%") : s;
  });
}

/**
 * `text.replace(/\$\{\?([a-zA-Z0-9_]+)\}(.*?)\$\{\/\1\}/gs, (_, name, body) => fn(name, body))` in linear time: that
 * regex rescans the rest of the text from every opening tag left unclosed.
 */
function replaceConditionals(text: string, fn: (name: string, body: string) => string): string {
  const closes = new Map<string, number[]>();
  for (const m of text.matchAll(/\$\{\/([a-zA-Z0-9_]+)\}/g)) {
    const at = closes.get(m[1]);
    if (at) at.push(m.index);
    else closes.set(m[1], [m.index]);
  }
  if (closes.size === 0) {
    return text;
  }

  // per name, the first close tag not yet passed; opening tags only move forward, so neither do these
  const next = new Map<string, number>();
  const open = /\$\{\?([a-zA-Z0-9_]+)\}/g;
  let out = "";
  let done = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text)) !== null) {
    const name = m[1];
    const at = closes.get(name);
    if (!at) continue;
    let k = next.get(name) ?? 0;
    while (k < at.length && at[k] < open.lastIndex) k++;
    next.set(name, k);
    if (k === at.length) continue;
    out += text.slice(done, m.index) + fn(name, text.slice(open.lastIndex, at[k]));
    done = at[k] + name.length + 4;
    open.lastIndex = done;
  }
  return out + text.slice(done);
}

/**
 * `text.replace(/\$\{([^:}?/][^:}]*)\}/g, (_, name) => fn(name))` in linear time. A `${` whose name runs into a `:`
 * or the end fails there, and so does every `${` before that point, so the scan resumes after it instead of
 * rescanning from each one.
 */
function replacePlaceholders(text: string, fn: (name: string) => string): string {
  let out = "";
  let done = 0;
  let i = text.indexOf("${");
  while (i !== -1) {
    const first = text[i + 2];
    if (first === undefined || ":}?/".includes(first)) {
      i = text.indexOf("${", i + 2);
      continue;
    }
    let end = i + 3;
    while (end < text.length && text[end] !== ":" && text[end] !== "}") end++;
    if (text[end] === "}") {
      out += text.slice(done, i) + fn(text.slice(i + 2, end));
      done = end + 1;
    }
    i = text.indexOf("${", end);
  }
  return out + text.slice(done);
}
