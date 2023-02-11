import { Injectable } from "@spinajs/di";

/**
 * We redeclare thees interfaces & class, to not include whole Intl package.
 * It can cause probles because it uses native nodejs modules & functions.
 * Its easier that way to fake it
 */

export interface IPhraseWithOptions {
    phrase: string;
    locale: string;
}

export abstract class Intl { 
    public abstract __(text: string | IPhraseWithOptions, ...args: any[]): string;
}

/**
 * Electron renderer version of intl. It works as a proxy between Intl implementation and render side.
 */
@Injectable(Intl)
export class ElectronRendererIntl extends Intl {
    public __(text: string | IPhraseWithOptions, ...args: any[]): string {
        return window.ipc.__spinaJsIpcBridge.callSync("__", "Intl", null, text, ...args);
    }
}
