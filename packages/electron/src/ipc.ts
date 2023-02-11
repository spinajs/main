import { DI } from "@spinajs/di";
import { Orm } from "@spinajs/orm";
import { ipcMain, IpcMainEvent } from "electron";
import { Log } from "@spinajs/log-common";

const log = () => DI.resolve(Log, ['ipc']);

export default function exposeIpcBridge() {
    ipcMain.handle("__spinajsIpcBridge:callOnOrmConnection", async (_event: IpcMainEvent, connection: string, method: string, ...args) => {

        log().trace(`call on __spinajsIpcBridge::callOnOrmConnection(), method: ${method}`);

        const _s = await DI.get(Orm);
        if (!_s) {
            const msg = `call on __spinajsIpcBridge::callOnOrmConnection() failed, method: ${method}`;
            const error = new Error(msg);
            log().error(msg);

            // inform render process
            throw error;
        }

        const _conn = _s.Connections.get(connection);
        if (!_conn) {

            const msg = `call on __spinajsIpcBridge::callOnOrmConnection() failed, method: ${method}, connection: ${connection}"`;
            const error = new Error(msg);
            log().error(msg);

            // inform render process
            throw error;
        }

        return (_conn as any)[method](...args).then((result: any) => {
            return result;
        }).catch((err: unknown) => {

            const msg = `call on __spinajsIpcBridge::callOnOrmConnection() failed, method: ${method}, connection: ${connection}`;
            const error = new Error(msg, {
                cause: err
            });
            log().error(msg);

            // inform render process
            return error;
        });

    });

    ipcMain.handle("__spinajsIpcBridge:call", async (_event: IpcMainEvent, method: string, service: string, resolveArgs: any[], ...args) => {

        log().trace(`call on __spinajsIpcBridge::call(), method: ${method}, service: ${service}`);

        const _s = await DI.resolve<any>(service, resolveArgs ?? undefined);
        if (!_s) {
            const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, no service named: ${service} exists in DI container`;
            const error = new Error(msg);
            log().error(msg);

            // inform render process
            return error;
        }

        if (method in _s && typeof _s[method] === "function") {
            try {
                return await _s[method](...args);
            } catch (err) {

                const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, no service named: ${service}, cause: ${err.message}`;
                log().error(msg);

                throw new Error(msg, {
                    cause: err
                });

            }

        } else {
            const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, not found in service named: ${service}`;
            log().error(msg);

            throw new Error(msg);
        }

    });

    ipcMain.on("__spinajsIpcBridge:callSync", (event: IpcMainEvent, method: string, service: string, ...args) => {

        log().trace(`call on __spinajsIpcBridge::callSync(), method: ${method}, service: ${service}`);


        const _s = DI.get<any>(service);
        if (!_s) {
            const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, no service named: ${service} exists in DI container`;
            log().error(msg);


            // we return error, in render process preload we check & throw
            event.returnValue = new Error(msg);
        }

        if (method in _s && typeof _s[method] === "function") {
            try {
                event.returnValue = _s[method](...args);
            } catch (err) {
                const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, no service named: ${service}, cause: ${err.message}`;
                log().error(msg);

                // we return error, in render process preload we check & throw
                event.returnValue = new Error(msg);
            }
        } else {
            const msg = `call on __spinajsIpcBridge::call() failed, method: ${method}, not found in service named: ${service}`;
            log().error(msg);

            // we return error, in render process preload we check & throw
            event.returnValue = new Error(msg);
        }
    });

    log().info(`Electron main process exposed spinajs IPC bridge !`);
}
