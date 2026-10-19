import { DI } from "@spinajs/di";
import { ipcMain, IpcMainEvent } from "electron";
import { Log } from "@spinajs/log-common";
import { callOnOrmConnection, callService, callServiceSync } from "./ipc-calls.js";

const log = () => DI.resolve(Log, ["ipc"]);

export default function exposeIpcBridge() {
  ipcMain.handle("__spinajsIpcBridge:callOnOrmConnection", (_event: IpcMainEvent, connection: string, method: string, ...args) => callOnOrmConnection(connection, method, ...args));

  ipcMain.handle("__spinajsIpcBridge:call", (_event: IpcMainEvent, method: string, service: string, resolveArgs: any[], ...args) => callService(method, service, resolveArgs, ...args));

  ipcMain.on("__spinajsIpcBridge:callSync", (event: IpcMainEvent, method: string, service: string, ...args) => callServiceSync(event, method, service, ...args));

  // Runs at import time: before @spinajs/log registers a Log, resolving it would build the abstract one.
  if (DI.check(Log)) {
    log().info(`Electron main process exposed spinajs IPC bridge !`);
  }
}
