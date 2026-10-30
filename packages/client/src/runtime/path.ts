/**
 * Route path templates: `{name}` is one segment, `{*name}` takes an array joined with `/`, `[...]` is an optional
 * group left out when any placeholder inside it has no value, and `\` escapes the next character.
 */
type Token = { text: string } | { param: string; splat: boolean } | { group: Token[] };

export interface PathArgument {
  value: unknown;
  text: string;
}

const cache = new Map<string, Token[]>();

function parseTokens(template: string, start: number, nested: boolean): [Token[], number] {
  const tokens: Token[] = [];
  let text = '';
  const flush = () => {
    if (text) tokens.push({ text });
    text = '';
  };
  let i = start;
  while (i < template.length) {
    const char = template[i];
    if (char === '\\' && i + 1 < template.length) {
      text += template[i + 1];
      i += 2;
    } else if (char === '{') {
      const end = template.indexOf('}', i);
      if (end < 0) throw new TypeError(`Unclosed placeholder in path '${template}'`);
      flush();
      const name = template.slice(i + 1, end);
      tokens.push(name.startsWith('*') ? { param: name.slice(1), splat: true } : { param: name, splat: false });
      i = end + 1;
    } else if (char === '[') {
      flush();
      const [group, next] = parseTokens(template, i + 1, true);
      tokens.push({ group });
      i = next;
    } else if (char === ']' && nested) {
      flush();
      return [tokens, i + 1];
    } else {
      text += char;
      i++;
    }
  }
  if (nested) throw new TypeError(`Unclosed optional group in path '${template}'`);
  flush();
  return [tokens, i];
}

function tokensOf(template: string): Token[] {
  let tokens = cache.get(template);
  if (!tokens) {
    tokens = parseTokens(template, 0, false)[0];
    cache.set(template, tokens);
  }
  return tokens;
}

// encodeURIComponent keeps `.`, and URL parsers resolve `.` and `..` segments (`%2E` too), so they would leave the route.
function segment(text: string, name: string, route: string): string {
  if (text === '' || text === '.' || text === '..') {
    throw new TypeError(`Path parameter '${name}' of ${route} is '${text}', which would change the request path`);
  }
  return encodeURIComponent(text);
}

function splatSegments(argument: PathArgument, name: string, route: string): string {
  const items = Array.isArray(argument.value) ? (argument.value as unknown[]) : undefined;
  if (!items || items.length === 0) throw new TypeError(`Path parameter '${name}' of ${route} takes a non-empty array of segments`);
  return items.map((item) => segment(item instanceof Date ? item.toISOString() : String(item), name, route)).join('/');
}

function render(tokens: Token[], values: Record<string, PathArgument>, route: string, missing: string[]): string {
  let out = '';
  for (const token of tokens) {
    if ('text' in token) {
      out += token.text;
    } else if ('group' in token) {
      const inner: string[] = [];
      const rendered = render(token.group, values, route, inner);
      if (inner.length === 0) out += rendered;
    } else {
      const argument = values[token.param];
      if (argument === undefined) missing.push(token.param);
      else out += token.splat ? splatSegments(argument, token.param, route) : segment(argument.text, token.param, route);
    }
  }
  return out;
}

export function fillPath(template: string, values: Record<string, PathArgument>, route: string): string {
  const missing: string[] = [];
  const path = render(tokensOf(template), values, route, missing);
  if (missing.length > 0) throw new TypeError(`Missing path parameter '${missing[0]}' for ${route}`);
  return path;
}
