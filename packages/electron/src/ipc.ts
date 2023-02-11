import { DI } from "@spinajs/di";
import { Orm } from "@spinajs/orm";
import { ipcMain, IpcMainEvent } from "electron";

ipcMain.handle("__spinajsIpcBridge:callOnOrmConnection", async (_event: IpcMainEvent, connection: string,method: string, ...args) => {

    const _s = await DI.get(Orm);
    if(!_s){
        throw new Error(`Service Orm not initialized. Resolve it before usage from render process.`);
    }
    
    const _conn = _s.Connections.get(connection);
    if(!_conn){
        throw new Error(`Connection ${connection} is not created. Create it before usage from render process.`);
    }

    return (_conn as any)[method](...args).then((result : any)=>{ 
        return result;
    });

});
 
ipcMain.handle("__spinajsIpcBridge:call", async (_event: IpcMainEvent, method: string, service: string, resolveArgs: any[],  ...args) => {
    const _s = await DI.resolve<any>(service, resolveArgs ?? undefined);
    if(!_s){
        throw new Error(`Service ${service} not found`);
    }
    
    if (method in _s && typeof _s[method] === "function") {
        return _s[method](...args);
    } else {
        throw new Error(`Method ${method} not found in service ${service}`);
    }

});

ipcMain.on("__spinajsIpcBridge:callSync", (event: IpcMainEvent, method: string, service: string, ...args) => {
    console.log("ipcMain.handle: ", args);

    const _s = DI.get<any>(service);
    if(!_s){
        event.returnValue = new Error(`Service ${service} not found`);
    }
    
    if (method in _s && typeof _s[method] === "function") {
        event.returnValue = _s[method](...args);
    } else {
        event.returnValue = Error(`Method ${method} not found in service ${service}`);
    }
});

