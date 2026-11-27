/**
 * Renders the tags of a domain's access plan (`AccessPlanCache.tags` and the plan terms' `cacheTags`) as tags of a cache
 * outside authz, such that every change the domain hears bumps one of them. Without a registered implementation, nothing
 * filtered by an access plan is cached.
 */
export abstract class AuthzCacheTags {
  /** Undefined when the changes of `domain` do not reach that cache. */
  abstract render(domain: string, tags: readonly string[]): readonly string[] | undefined;
}
