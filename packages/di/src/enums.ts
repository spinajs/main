/**
 * How to resolve class
 * @enum
 */
export enum ResolveType {
  /**
   * Application wise single instance. Default behaviour
   */
  Singleton,

  /**
   * New instance every time is requested
   */
  NewInstance,

  /**
   * New instance per child DI container.
   */
  PerChildContainer,
}
