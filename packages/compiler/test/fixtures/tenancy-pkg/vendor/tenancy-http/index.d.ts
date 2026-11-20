import type { RouteMiddleware } from '@spinajs/http';

export type TenantRouteDeclaration = { readonly tenancy: 'required' } | { readonly tenancy: 'none' } | { readonly tenancy: 'all'; readonly reason: string };

export declare abstract class TenantMiddleware extends RouteMiddleware {}

export declare function TenantRoute(): ClassDecorator & MethodDecorator;
export declare function NoTenant(): ClassDecorator & MethodDecorator;
export declare function AllTenants(reason: string): ClassDecorator & MethodDecorator;
