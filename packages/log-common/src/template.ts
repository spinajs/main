// JSON.stringify leaves U+007F-U+009F, Unicode line breaks and direction marks as they are, and a text target's layout
// expands a `${name}` that a value brings into the message.
const UNSAFE = /[$\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PLAIN = /^[\p{L}\p{N}_.,:;/\\+@#~*!?&|()[\]<>'-]+$/u;
const CONDITIONAL = /\$\{\?([a-zA-Z0-9_]+)\}(.*?)\$\{\/\1\}/gs;
const PLACEHOLDER = /\$\{([^:}?/][^:}]*)\}/g;

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
