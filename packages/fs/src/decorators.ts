import { getFs } from "./helpers.js";

/**
 * Injects file system provider. Provider must be configured in configuration files & exists
 *
 * @param provider - provider name
 * @returns
 */
export function FileSystem(provider: string) {
    return (target: any, key: string): any => {

        const getter = () => {
            return getFs(provider);
        };

        Object.defineProperty(target, key, {
            get: getter,
            enumerable: false,
            configurable: false,
        });
    };
}