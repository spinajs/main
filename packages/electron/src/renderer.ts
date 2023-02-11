import { DI, IContainer } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { Orm } from '@spinajs/orm';
import { Configuration } from "@spinajs/configuration-common";

import { ElectronRendererLogger } from './electronRendererLogger.js';
import { ElectronRendererConfiguration } from './electronRendererConfiguration.js';
import { ElectronRendererIntl, Intl } from "./electronRendererIntl.js"
import { ElectronRendererOrm, RendererOrmDriverBridge } from './electronRendererOrm.js';
import { EmailService } from './electronEmail.js';


export interface IpcRenderer {
    __spinaJsIpcBridge: {
        call(method: string, service: string, resovleArgs: any[], ...args: any[]): Promise<any>;
        callSync(method: string, service: string, resovleArgs: any[], ...args: any[]): any;
        callOnOrmConnection(connection: string, method: string, ...args: any[]): Promise<any>;
    }
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
DI.register(RendererOrmDriverBridge).as('orm-driver-sqlite');
DI.register(ElectronRendererOrm).as(Orm);
DI.register(ElectronRendererConfiguration).as(Configuration);
DI.register(EmailService).asSelf();
DI.register(ElectronRendererIntl).as(Intl);
