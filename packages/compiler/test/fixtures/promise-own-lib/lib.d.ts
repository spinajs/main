// A project's own lib under `noLib`, without the `no-default-lib` directive: its `Promise` is still the global one.
interface Array<T> { length: number; [n: number]: T }
interface Boolean {}
interface Function {}
interface CallableFunction {}
interface NewableFunction {}
interface IArguments {}
interface Number {}
interface Object {}
interface RegExp {}
interface String {}
interface PromiseLike<T> { then(onfulfilled?: (value: T) => unknown): PromiseLike<unknown> }
interface Promise<T> { then(onfulfilled?: (value: T) => unknown): Promise<unknown> }
