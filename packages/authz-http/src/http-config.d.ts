import { Bootstrapper } from '@spinajs/di';
/** One `authz.http.services` entry as configured. */
export interface ServiceEntry {
    readonly name: string;
    readonly header: string;
    /** Several for rotation. */
    readonly token: string | readonly string[];
    readonly attributes?: Readonly<Record<string, unknown>>;
}
/** A service entry as ServicePrincipalSource matches it. */
export interface ServicePrincipalConfig {
    readonly name: string;
    /** Lower-cased: node lower-cases the names of `req.headers`. */
    readonly header: string;
    readonly tokens: readonly string[];
    readonly attributes: Readonly<Record<string, unknown>>;
}
export interface LinksConfig {
    readonly query: string | null;
    readonly header: string | null;
    readonly cookie: string | null;
}
/** `authz.http.*` as AUTHZ_HTTP_CONFIGURATION_SCHEMA leaves it: every key set. */
export interface AuthzHttpConfig {
    readonly services: readonly ServiceEntry[];
    readonly explainRoute: {
        readonly enabled: boolean;
        readonly permission: string;
    };
    readonly links: LinksConfig;
    /** The domain GET /user/access, POST /user/access/checks and the explain route answer for. */
    readonly access: {
        readonly domain: string;
    };
    /** The domain whose AuthzAdmin the authz-http-admin routes use. */
    readonly admin: {
        readonly domain: string;
    };
    /** GET /user/access/events: past `maxStreamsPerPrincipal` open streams of one principal, the oldest is closed. */
    readonly events: {
        readonly maxStreamsPerPrincipal: number;
    };
}
export declare const AUTHZ_HTTP_CONFIGURATION_SCHEMA: {
    $id: string;
    $configurationModule: string;
    description: string;
    type: string;
    properties: {
        services: {
            type: string;
            default: never[];
            items: {
                type: string;
                required: string[];
                properties: {
                    name: {
                        type: string;
                        minLength: number;
                    };
                    header: {
                        type: string;
                        minLength: number;
                    };
                    token: {
                        anyOf: ({
                            type: string;
                            minLength: number;
                        } | {
                            type: string;
                            minItems: number;
                            items: {
                                type: string;
                                minLength: number;
                            };
                        })[];
                    };
                    attributes: {
                        type: string;
                    };
                };
            };
        };
        explainRoute: {
            type: string;
            default: {};
            properties: {
                enabled: {
                    type: string;
                    default: boolean;
                };
                permission: {
                    type: string;
                    minLength: number;
                    default: string;
                };
            };
        };
        links: {
            type: string;
            default: {};
            properties: {
                query: {
                    type: string[];
                    minLength: number;
                    default: string;
                };
                header: {
                    type: string[];
                    minLength: number;
                    default: string;
                };
                cookie: {
                    type: string[];
                    minLength: number;
                    default: null;
                };
            };
        };
        access: {
            type: string;
            default: {};
            properties: {
                domain: {
                    type: string;
                    minLength: number;
                    default: string;
                };
            };
        };
        admin: {
            type: string;
            default: {};
            properties: {
                domain: {
                    type: string;
                    minLength: number;
                    default: string;
                };
            };
        };
        events: {
            type: string;
            default: {};
            properties: {
                maxStreamsPerPrincipal: {
                    type: string;
                    minimum: number;
                    default: number;
                };
            };
        };
    };
};
export declare class AuthzHttpConfigBootstrapper extends Bootstrapper {
    bootstrap(): void;
}
/** The configured services as ServicePrincipalSource matches them. */
export declare function servicePrincipals(services: readonly ServiceEntry[]): ServicePrincipalConfig[];
//# sourceMappingURL=http-config.d.ts.map