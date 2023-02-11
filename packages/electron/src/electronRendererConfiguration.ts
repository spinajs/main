import { Class, Injectable } from "@spinajs/di";
import { Configuration, ConfigurationSource, IConfigLike } from "@spinajs/configuration-common";

/**
 * Electron version of configuration. It proxies all function calls via IPC to nodejs side
 * Only get function is implemented.
 * 
 * It must extend framework configuragion class becouse of type checkign
 * in various places
 */
@Injectable(Configuration)
export class ElectronRendererConfiguration extends Configuration {

    /**
     * @throws  always not implemented 
     */
    get RootConfig(): IConfigLike {
        throw new Error("Method not implemented.");
    }

    /**
     * @throws  always not implemented 
     */
    set(_path: string | string[], _value: unknown): void {
        throw new Error("Method not implemented.");
    }

    /**
     * @throws  always not implemented 
     */
    merge(_path: string | string[], _value: unknown): void {
        throw new Error("Method not implemented.");
    }


    /**
     * @throws  always not implemented 
     */
    mergeSource(_source: Class<ConfigurationSource>): Promise<void> {
        throw new Error("Method not implemented.");
    }


    /**
     * @throws  always not implemented 
     */
    load(): Promise<void> {
        throw new Error("Method not implemented.");
    }


    /**
     * @throws  always not implemented 
     */
    protected onLoad(): unknown {
        throw new Error("Method not implemented.");
    }



    public get<T>(path: string[] | string, defaultValue?: T): T {
        return window.ipc.__spinaJsIpcBridge.callSync("get", "Configuration", null, path, defaultValue);
    }
}