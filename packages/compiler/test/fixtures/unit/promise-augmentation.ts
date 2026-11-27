export {};

declare global {
  interface Promise<T> { appExtra?: T }
}
