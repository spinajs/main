import { Injectable, DI } from '@spinajs/di';
import { DateTime } from 'luxon';

export abstract class ConfigVariable {
  public abstract get Name(): string;
  public abstract Value(option?: string): string;
}

@Injectable(ConfigVariable)
export class DateTimeLogVariable extends ConfigVariable {
  public get Name(): string {
    return 'datetime';
  }
  public Value(option?: string): string {
    return DateTime.now().toFormat(option ?? 'dd/MM/yyyy HH:mm:ss.SSS ZZ');
  }
}

@Injectable(ConfigVariable)
export class DateLogVariable extends ConfigVariable {
  constructor(protected format?: string) {
    super();
  }

  public get Name(): string {
    return 'date';
  }
  public Value(option?: string): string {
    return DateTime.now().toFormat(option ?? this.format ?? 'dd/MM/yyyy');
  }
}

@Injectable(ConfigVariable)
export class TimeLogVariable extends ConfigVariable {
  constructor(protected format?: string) {
    super();
  }

  public get Name(): string {
    return 'time';
  }
  public Value(option?: string): string {
    return DateTime.now().toFormat(option ?? this.format ?? 'HH:mm:ss.SSS');
  }
}

@Injectable(ConfigVariable)
export class TimestampVariable extends ConfigVariable {
  public get Name(): string {
    return 'timestamp';
  }

  /**
   * @param option - 's' for unix seconds, otherwise milliseconds (default)
   */
  public Value(option?: string): string {
    const millis = DateTime.now().toMillis();
    return option === 's' ? String(Math.floor(millis / 1000)) : String(millis);
  }
}

@Injectable(ConfigVariable)
export class UtcDateTimeLogVariable extends ConfigVariable {
  public get Name(): string {
    return 'utcdatetime';
  }
  public Value(option?: string): string {
    return DateTime.utc().toFormat(option ?? 'dd/MM/yyyy HH:mm:ss.SSS ZZ');
  }
}

@Injectable(ConfigVariable)
export class UtcDateLogVariable extends ConfigVariable {
  public get Name(): string {
    return 'utcdate';
  }
  public Value(option?: string): string {
    return DateTime.utc().toFormat(option ?? 'dd/MM/yyyy');
  }
}

@Injectable(ConfigVariable)
export class UtcTimeLogVariable extends ConfigVariable {
  public get Name(): string {
    return 'utctime';
  }
  public Value(option?: string): string {
    return DateTime.utc().toFormat(option ?? 'HH:mm:ss.SSS');
  }
}

export interface IConfigVariable {
  [key: string]: unknown | (() => unknown);
}

export interface IConfiguStatiVariables {
  message?: string;
}

export type ConfVariables = IConfiguStatiVariables & IConfigVariable;

/**
 * Formats layout by filling vars from customVars prop
 * eg `Hello world {datetime} {message}` will be formatted using values
 * from customVars
 *
 * NOTE: field message in custom vars will be formatted too.
 *
 * @param customVars - additional custom vars to look for, if it contains message field, it will format it too
 * @param layout - message layout
 * @returns
 */
export function format(customVars: ConfVariables | null, layout: string): string {
  if (customVars?.message) {
    return _format(
      {
        ...customVars,
        message: _format(customVars, customVars.message),
      } as ConfVariables,
      layout,
    );
  }

  return _format(customVars as ConfVariables, layout);
}

/**
 * This reg is safe, checked in RegexBuddy
 */
// eslint-disable-next-line security/detect-unsafe-regex
const LayoutRegexp = /\$\{([^:\}]*)(:([^\}]*))?\}/gm;
const Vars: Map<string, ConfigVariable> = new Map<string, ConfigVariable>();
let VarsSource: ConfigVariable[] | null = null;
let VarsSourceLength = 0;

// DI returns the same cached array until a new ConfigVariable is registered or the cache is cleared,
// so the name map is rebuilt only when that array changes.
function _refreshVars() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const resolved = DI.resolve(Array.ofType(ConfigVariable)) as ConfigVariable[];
  if (resolved === VarsSource && resolved.length === VarsSourceLength) {
    return;
  }

  Vars.clear();
  resolved.forEach((v: ConfigVariable) => Vars.set(v.Name, v));
  VarsSource = resolved;
  VarsSourceLength = resolved.length;
}

function _isSet(value: unknown) {
  return value !== undefined && value !== null;
}

/**
 *
 * Replace all occurences and escape random regexp patterns in target string
 * Sometimes in passed string we had random patterns eg. $` and its stirng.replace special command that coused unwanted behaviour
 *
 * @param pattern
 * @param str1
 * @param str2
 * @param ignore
 * @returns
 */
function _replaceAll(pattern: string, str1: string, str2: string, ignore?: string) {
  return pattern.replace(
    new RegExp(str1.replace(/([\/\,\!\\\^\$\{\}\[\]\(\)\.\*\+\?\|\<\>\-\&])/g, '\\$&'), ignore ? 'gi' : 'g'),
    typeof str2 == 'string' ? str2.replace(/\$/g, '$$$$') : str2,
  );
}

/**
 * `text.replace(/\$\{\?([a-zA-Z0-9_]+)\}(.*?)\$\{\/\1\}/gs, (_, name, body) => fn(name, body))` in linear time: that
 * regex rescans the rest of the text from every opening tag left unclosed, and log messages pass through here.
 */
function _replaceConditionals(text: string, fn: (name: string, body: string) => string): string {
  const closes = new Map<string, number[]>();
  for (const m of text.matchAll(/\$\{\/([a-zA-Z0-9_]+)\}/g)) {
    const at = closes.get(m[1]);
    if (at) at.push(m.index!);
    else closes.set(m[1], [m.index!]);
  }
  if (closes.size === 0) {
    return text;
  }

  // per name, the first close tag not yet passed; opening tags only move forward, so neither do these
  const next = new Map<string, number>();
  const open = /\$\{\?([a-zA-Z0-9_]+)\}/g;
  let out = '';
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

function _format(vars: ConfVariables, txt: string) {
  _refreshVars();

  // First, process conditional blocks ${?variable}...${/variable}
  // We need to evaluate the condition BEFORE replacing variables in the content
  let result = _replaceConditionals(txt, (varName, content) => {
    const value = vars?.[varName];
    if (_isSet(value) && value !== '' && value !== false) {
      // Return the content to be processed for variable substitution
      return content;
    }
    return '';
  });


  LayoutRegexp.lastIndex = 0;

  // A `${` matches up to the next `}`, so none after the last `}` can; without the cut each of those would
  // rescan the rest of the text.
  const varMatch = [...result.slice(0, result.lastIndexOf('}') + 1).matchAll(LayoutRegexp)];
  if (!varMatch) {
    return result;
  }

  varMatch.forEach((v) => {
    if (vars && _isSet(vars[v[1]])) {
      const fVar = vars[v[1]] as (format?: string) => string;
      if (fVar instanceof Function) {
        result = result.replace(v[0], () => fVar(v[3] ?? null));
      }
      else if (v[3]) {
        if (typeof fVar[v[3]] === 'function') {
          result = result.replace(v[0], () => (fVar[v[3]] as any)());
          return;
        }

        // optional parameter eg. {object:property}
        result = result.replace(v[0], () => String(fVar[v[3]] ?? ''));
      }
      else {
        result = _replaceAll(result, v[0], String(fVar));
      }
    } else {
      const variable = Vars.get(v[1]);
      if (variable) {
        // optional parameter eg. {env:PORT}
        result = result.replace(v[0], () => variable.Value(v[3] ?? null));
      } else {
        result = result.replace(v[0], '');
      }
    }
  });

  return result;
}
