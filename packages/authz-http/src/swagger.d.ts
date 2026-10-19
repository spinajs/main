import type { Permission, ResourceType } from '@spinajs/authz';
import type { AccessKey } from './access/descriptor.js';
/** Where an operation finds its resource, for `x-authz-resource`. */
export interface SwaggerAccessResource {
    /** Absent for `fromModel`, whose type the ORM adapter knows. */
    readonly type?: ResourceType;
    readonly in?: 'path' | 'body' | 'query';
    readonly name?: string;
    readonly by?: string;
    readonly model?: string;
}
/** The OpenAPI vendor extensions of one operation (design §11.5: they replace `x-rbac-*`). */
export interface SwaggerAccess {
    /** Any of these (the route's own @Access, else the class's). */
    readonly 'x-authz-permission': readonly Permission[];
    /** A class-level @Access the route's own one narrows (both must pass). */
    readonly 'x-authz-controller-permission'?: readonly Permission[];
    readonly 'x-authz-resource': SwaggerAccessResource;
    readonly 'x-authz-domain'?: string;
    readonly 'x-authz-anonymous'?: true;
    readonly 'x-authz-unscoped'?: string;
    /** `@UnfilteredInput(reason)`: the body is not field-filtered. */
    readonly 'x-authz-unfiltered-input'?: string;
}
/**
 * What `@Access`, `@AllowAnonymous` and `@Unscoped` declare for one route, as OpenAPI vendor
 * extensions read from `ACCESS_DESCRIPTOR`; undefined for a route no `@Access` guards. For
 * http-swagger (plan C7).
 */
export declare function swaggerAccess(controller: object, method: AccessKey): SwaggerAccess | undefined;
//# sourceMappingURL=swagger.d.ts.map