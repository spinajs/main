// JSON.stringify leaves U+007F-U+009F, Unicode line breaks and direction marks as they are, and a text target's layout
// expands a `${name}` that a value brings into the message.
const UNSAFE = /[$\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PLAIN = /^[A-Za-z0-9_.:/+-]+$/;
const CONDITIONAL = /\$\{\?([a-zA-Z0-9_]+)\}(.*?)\$\{\/\1\}/gs;
const PLACEHOLDER = /\$\{([^:}?/][^:}]*)\}/g;

const has = (fields: Record<string, unknown>, name: string): boolean => {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) {
    return false;
  }
  const v = fields[name];
  return v !== undefined && v !== null && v !== "";
};

function text(v: unknown): string {
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? v.toISOString() : String(v);
  }
  if (typeof v === "object" && v !== null) {
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  }
  return typeof v === "function" ? "" : String(v);
}

/**
 * Renders one field value for a log line: a plain token as it is, anything else quoted and escaped, so a value can
 * forge neither a field nor a line.
 */
export function renderValue(v: unknown): string {
  const s = text(v);
  if (PLAIN.test(s)) {
    return s;
  }
  return JSON.stringify(s).replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
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
  return template
    .replace(CONDITIONAL, (_, name: string, body: string) => (has(fields, name) ? body : ""))
    .replace(PLACEHOLDER, (_, name: string) => {
      if (!has(fields, name)) {
        return "";
      }
      const s = renderValue(fields[name]);
      return escapePercent ? s.replace(/%/g, "%%") : s;
    });
}
