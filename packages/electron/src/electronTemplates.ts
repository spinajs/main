
/**
 * We redeclare thees interfaces & class, to not include whole Intl package.
 * It can cause probles because it uses native nodejs modules & functions.
 * Its easier that way to fake it
 */

import { Injectable } from "@spinajs/di";

@Injectable()
export class Templates {

    /**
     * Renders template and returns it as string
     * 
     * @param template template file to render
     * @param model data
     * @param language language ( optional )
     * @returns 
     */
    public async render(template: string, model: unknown, language?: string): Promise<string> {
        return window.ipc.__spinaJsIpcBridge.call("render", "Templates", null, template, model, language);
    }

    /**
     * 
     * Renders template to given file
     * 
     * @param template template file to render
     * @param model data
     * @param filePath destination file path
     * @param language language ( optional )
     * @returns 
     */
    public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
        return window.ipc.__spinaJsIpcBridge.call("renderToFile", "Templates", null, template, model, filePath, language);
    }
}