import { Inject, SyncModule } from "@spinajs/di";
import * as _ from "lodash";
import { LogVariable, ILogEntry, ICommonTargetOptions, LogVariables, ILogRule, ITargetsOption } from "@spinajs/log-common";

export interface ILogTargetDesc {
  instance: LogTarget<ICommonTargetOptions>;
  options?: ITargetsOption;
  rule: ILogRule;
}

export abstract class LogTarget<T extends ICommonTargetOptions> extends SyncModule {
  public HasError = false;
  public Error: Error | null | unknown = null;
  protected VariablesDictionary: Map<string, LogVariable> = new Map();
  protected LayoutRegexp: RegExp;
  protected Options: T;

  constructor(options: T) {
    super();

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
}
