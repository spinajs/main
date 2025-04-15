/**
 * Wraps callback function into lazy statement.
 * 
 * Callback execution will be delayed
 */
export class Lazy<T> {
    constructor(protected callback: () => T) {
    }

    public static oF<T>(callback: () => T) {
        return new Lazy(callback);
    }

    public call(): T {
        return this.callback?.();
    }
}