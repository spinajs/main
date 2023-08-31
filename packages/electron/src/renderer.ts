import { DI, IContainer } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { RendererOrmDriverBridge } from './electronRendererOrm.js';
import { ElectronRendererLogger } from './electronRendererLogger.js';
import './electronRendererConfiguration.js';

export * from './electronEmail.js';
export * from "./electronRendererIntl.js"
export * from './electronRendererOrm.js';
export * from './electronRendererConfiguration.js';
export * from './electronRendererLogger.js';
export * from './electronTemplates.js';

export interface IIpcRendererBridge {

    /**
     * Calls asynchronously method on given service
     * 
     * @param method method to call on service
     * @param service service name 
     * @param resovleArgs service resolve args ( if its about to create )
     * @param args args to method invoked on service
     */
    call(method: string, service: string, resovleArgs: any[], ...args: any[]): Promise<any>;

    /**
     * Calls synchronously method on given service
     * 
     * @param method method to call on service
     * @param service service name
     * @param resovleArgs servie resolve args ( if its about to create )
     * @param args args to method invoked on service
     */
    callSync(method: string, service: string, ...args: any[]): any;

    /**
     * Special case for calling methods on Orm connections. Call is made not 
     * on service but on connection itself, and its identified by connection name.
     * 
     * We do this, because OrmDriver are not singleton and we are not tracking them in DI container.
     * 
     * @param connection orm connection name
     * @param method method to call on connection
     * @param args method args
     */
    callOnOrmConnection(connection: string, method: string, ...args: any[]): Promise<any>;
}

export interface IpcRenderer {
    __spinaJsIpcBridge: IIpcRendererBridge;
}

declare global {
    interface Window {
        ipc: IpcRenderer;
    }
}

const logFactoryFunction = (container: IContainer, logName: string) => {
    if (ElectronRendererLogger.Loggers.has(logName)) {
        return ElectronRendererLogger.Loggers.get(logName);
    }
    return container.resolve("__logImplementation__", [logName]);
};

// register as string identifier to allow for
// resolving logs without referencing class
// to avoid circular dependencies in some @spinajs packages
// it should not be used in production code
DI.register(logFactoryFunction).as("__log__");

// register log factory function as Log class
// this way we can create or return already created
// log objects
DI.register(logFactoryFunction).as(Log);

// register Log class as string literal
// so we can resolve Log class
// it should not be used in production code
DI.register(ElectronRendererLogger).as("__logImplementation__");

/**
 * Register all services that are available in renderer process by default
 */

// register fake drivers for various databases types
DI.register(RendererOrmDriverBridge).as('orm-driver-sqlite');
DI.register(RendererOrmDriverBridge).as('orm-driver-mysql');
DI.register(RendererOrmDriverBridge).as('orm-driver-mssql');


