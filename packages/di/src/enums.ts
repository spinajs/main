/**
 * How to resolve class
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

  /**
   * Singleton per target type
   *
   * eg. if we have multiple registered types at one base type
   * we can resolve any of it once
   *
   * In comparison, Singleton flag means that only one instance can be resolved
   * for base class
   */
  PerInstance,

  /**
   * Only one instance with given name can exists of the same service
   */
  PerInstanceCheck,
}
