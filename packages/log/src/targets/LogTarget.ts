import { ICommonTargetOptions } from './../types';
import { Inject, SyncModule } from "@spinajs/di";
import _ from "lodash";
import { LogVariable, ILogTargetData } from "../types";

@Inject(Array.ofType(LogVariable))
export abstract class LogTarget<T extends ICommonTargetOptions> extends SyncModule {

    public HasError: boolean = false;
    public Error: Error | null = null;
    protected VariablesDictionary: Map<string, LogVariable> = new Map();
    protected LayoutRegexp: RegExp;
    protected Options: T;

    constructor(protected Variables: LogVariable[], options: T) {
        super();

        this.Variables.forEach(v => {
            this.VariablesDictionary.set(v.Name, v);
        });

        this.LayoutRegexp = /\{((.*?)(:(.*?))?)\}/gm

        if (options) {
            this.Options = _.merge(_.merge(this.Options, {
                enabled: true,
                layout: "{datetime} {level} {message} {error} ({logger})"
            }), options);
        }
    }

    public abstract write(data: ILogTargetData): Promise<void>;

    protected format(customVars: {}, layout: string): string {
        
        const self = this;

        if ((customVars as any).message) {
            return _format({
                ...customVars,
                message: _format(customVars, (customVars as any).message)
            }, layout)
        }

        return _format(customVars, layout);

        function _format(vars: {}, txt: string) {
            self.LayoutRegexp.lastIndex = 0;

            const varMatch = [...txt.matchAll(self.LayoutRegexp)];
            if (!varMatch) {
                return "";
            }

            let result = txt;

            varMatch.forEach(v => {

                if ((vars as any)[v[2]]) {
                    result = result.replace(v[0], (vars as any)[v[2]]);
                } else {

                    const variable = self.VariablesDictionary.get(v[2]);
                    if (variable) {
                        // optional parameter eg. {env:PORT}
                        if (v[3]) {
                            result = result.replace(v[0], variable.Value(v[4]));
                        } else {
                            result = result.replace(v[0], variable.Value());
                        }
                    }else{ 
                        result = result.replace(v[0], "");
                    }
                }
            })

            return result;
        }
    }
}