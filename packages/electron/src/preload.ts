// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { ipcRenderer, contextBridge } from "electron";

const _ipc = {
    __spinaJsIpcBridge: {

        callOnOrmConnection: (connection: string, ...args: any[]) => {
            return ipcRenderer.invoke("__spinajsIpcBridge:callOnOrmConnection", connection, ...args);
        },

        call: (method: string, service: string, ...args: any[]) => {
            return ipcRenderer.invoke("__spinajsIpcBridge:call", method, service, ...args);
        },

        callSync: (method: string, service: string, ...args: any[]) => {
            const result = ipcRenderer.sendSync("__spinajsIpcBridge:callSync", method, service, ...args);

            if(result instanceof Error){
                throw result;
            }

            return result;
        }
    }
};

contextBridge.exposeInMainWorld('ipc', _ipc);