import { Log, ILogEntry } from '@spinajs/log-common'

export class ElectronRendererLogger extends Log {

    public trace(message: string, ...args: any[]): void;
    public trace(err: Error, message: string, ...args: any[]): void;
    public trace(err: string | Error, message: string | any[], ...args: any[]): void;
    public trace(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("trace", "Log", [this.Name], ...args);
    }
    public debug(message: string, ...args: any[]): void;
    public debug(err: Error, message: string, ...args: any[]): void;
    public debug(err: string | Error, message: string | any[], ...args: any[]): void;
    public debug(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("debug", "Log", [this.Name], ...args);
    }
    public info(message: string, ...args: any[]): void;
    public info(err: Error, message: string, ...args: any[]): void;
    public info(err: string | Error, message: string | any[], ...args: any[]): void;
    public info(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("info", "Log", [this.Name], ...args);
    }
    public warn(message: string, ...args: any[]): void;
    public warn(err: Error, message: string, ...args: any[]): void;
    public warn(err: string | Error, message: string | any[], ...args: any[]): void;
    public warn(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("warn", "Log", [this.Name], ...args);
    }
    public error(message: string, ...args: any[]): void;
    public error(err: Error, message: string, ...args: any[]): void;
    public error(err: string | Error, message: string | any[], ...args: any[]): void;
    public error(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("error", "Log", [this.Name], ...args);
    }
    public fatal(message: string, ...args: any[]): void;
    public fatal(err: Error, message: string, ...args: any[]): void;
    public fatal(err: string | Error, message: string | any[], ...args: any[]): void;
    public fatal(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("fatal", "Log", [this.Name], ...args);
    }
    public security(message: string, ...args: any[]): void;
    public security(err: Error, message: string, ...args: any[]): void;
    public security(err: string | Error, message: string | any[], ...args: any[]): void;
    public security(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("security", "Log", [this.Name], ...args);
    }
    public success(message: string, ...args: any[]): void;
    public success(err: Error, message: string, ...args: any[]): void;
    public success(err: string | Error, message: string | any[], ...args: any[]): void;
    public success(...args: unknown[]): void {
        window.ipc.__spinaJsIpcBridge.call("success", "Log", [this.Name], ...args);
    }

    /**
     *  @throws always not implemented     
     */
    public child(_name: string, _variables?: any): Log {
        throw new Error('Method not implemented.');
    }

    /**
     *  @throws always not implemented     
     */
    public write(_entry: ILogEntry): Promise<PromiseSettledResult<void>[]> {
        throw new Error('Method not implemented.');
    }


}