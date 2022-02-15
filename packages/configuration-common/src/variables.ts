import { Injectable, DI } from '@spinajs/di';
import { DateTime } from 'luxon';
import { tmpdir } from 'os';

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
    return DateTime.now().toFormat(option ?? 'dd/MM/yyyy');
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
    return DateTime.now().toFormat(option ?? 'HH:mm:ss.SSS');
  }
}

@Injectable(ConfigVariable)
export class EnvVariable extends ConfigVariable {
  public get Name(): string {
    return 'env';
  }
  public Value(option: string): string {
    return process.env[`${option}`] ?? '';
  }
}

@Injectable(ConfigVariable)
export class PathVariable extends ConfigVariable {
  public get Name(): string {
    return 'path';
  }
  public Value(option?: string): string {
    switch (option) {
      case 'temp':
        return tmpdir();
      case 'appdata':
        return process.env.APPDATA;
    }
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

  return _format(customVars, layout);
}

/**
 * This reg is safe, checked in RegexBuddy
 */
// eslint-disable-next-line security/detect-unsafe-regex
const LayoutRegexp = /\$\{([^:\}]*)(:([^\}]*))?\}/gm;
const Vars: Map<string, ConfigVariable> = new Map<string, ConfigVariable>();

function _format(vars: ConfVariables, txt: string) {
  if (Vars.size === 0) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    DI.resolve(Array.ofType(ConfigVariable)).forEach((v: ConfigVariable) => Vars.set(v.Name, v));
  }

  LayoutRegexp.lastIndex = 0;

  const varMatch = [...txt.matchAll(LayoutRegexp)];
  if (!varMatch) {
    return '';
  }

  let result = txt;

  varMatch.forEach((v) => {
    if (vars && vars[v[1]]) {
      const fVar = vars[v[1]] as (format?: string) => string;
      if (fVar instanceof Function) {
        result = result.replace(v[0], fVar(v[3] ?? null));
      } else {
        result = result.replace(v[0], fVar);
      }
    } else {
      const variable = Vars.get(v[1]);
      if (variable) {
        // optional parameter eg. {env:PORT}
        result = result.replace(v[0], variable.Value(v[3] ?? null));
      } else {
        result = result.replace(v[0], '');
      }
    }
  });

  return result;
}
