import { Config } from "@spinajs/configuration/lib/decorators";
import { AsyncModule, Autoinject, IContainer } from "@spinajs/di";
import { DataValidator } from "@spinajs/validation";
import { ILogOptions } from "./types";
import { Log } from "./log";

export class LogBootstrap extends AsyncModule {

    @Autoinject()
    protected Validator: DataValidator;

    @Config("logger")
    protected Options: ILogOptions;

    public async resolveAsync(_: IContainer) {
        /**
         * Check if options are valid, if not break, break, break
         */
        this.Validator.validate("spinajs/log.configuration.schema.json", this.Options);


        process.on("uncaughtException", (err) => {
            Log.fatal(err, "Unhandled exception occured", "process");
        });

        process.on("unhandledRejection", (reason, p) => {
            Log.fatal(reason as any, "Unhandled rejection at Promise %s", "process", p);
        });
    }
}