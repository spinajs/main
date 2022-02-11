import { Inject, SyncModule } from "@spinajs/di";
import * as _ from "lodash";
import { LogVariable, ILogEntry, ICommonTargetOptions, LogVariables, ILogRule, ITargetsOption } from "@spinajs/log-common";

export interface ILogTargetDesc {
  instance: LogTarget<ICommonTargetOptions>;
  options?: ITargetsOption;
  rule: ILogRule;
}

@Inject(Array.ofType(LogVariable))
export abstract class LogTarget<T extends ICommonTargetOptions> extends SyncModule {
  public HasError = false;
  public Error: Error | null | unknown = null;
  protected VariablesDictionary: Map<string, LogVariable> = new Map();
  protected LayoutRegexp: RegExp;
  protected Options: T;

  constructor(protected Variables: LogVariable[], options: T) {
    super();

    this.Variables.forEach((v) => {
      this.VariablesDictionary.set(v.Name, v);
    });

    this.LayoutRegexp = /\{((.*?)(:(.*?))?)\}/gm;

    if (options) {
      this.Options = _.merge(
        _.merge(this.Options, {
          enabled: true,
          layout: "{datetime} {level} {message} {error} ({logger})",
        }),
        options
      );
    }
  }

  public abstract write(data: ILogEntry): Promise<void>;

  protected format(customVars: LogVariables | null, layout: string): string {
    if (customVars?.message) {
      return this._format(
        {
          ...customVars,
          message: this._format(customVars, customVars.message),
        } as LogVariables,
        layout
      );
    }

    return this._format(customVars, layout);
  }

  protected _format(vars: LogVariables, txt: string) {
    this.LayoutRegexp.lastIndex = 0;

    const varMatch = [...txt.matchAll(this.LayoutRegexp)];
    if (!varMatch) {
      return "";
    }

    let result = txt;

    varMatch.forEach((v) => {
      if (vars && vars[v[2]]) {
        const fVar = vars[v[2]] as (format?: string) => string;
        if (fVar instanceof Function) {
          result = result.replace(v[0], fVar(v[4] ?? null));
        } else {
          result = result.replace(v[0], fVar);
        }
      } else {
        const variable = this.VariablesDictionary.get(v[2]);
        if (variable) {
          // optional parameter eg. {env:PORT}
          result = result.replace(v[0], variable.Value(v[4] ?? null));
        } else {
          result = result.replace(v[0], "");
        }
      }
    });

    return result;
  }
}
