export namespace Util {
    export namespace Thread {

        export const sleep = (duration: number) => {
            return new Promise<void>((resolve) => {
                setTimeout(() => {
                    resolve();
                }, duration);
            });
        }
    }
}