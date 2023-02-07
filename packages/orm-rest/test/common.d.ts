/// <reference types="connect" />
import { FrameworkConfiguration } from '@spinajs/configuration';
import './migrations/Test_2022_06_28_01_13_00.js';
export declare function dir(path: string): string;
export declare function req(): ChaiHttp.Agent;
export declare class TestConfiguration extends FrameworkConfiguration {
    protected onLoad(): {
        system: {
            dirs: {
                controllers: string[];
            };
        };
        logger: {
            targets: {
                name: string;
                type: string;
            }[];
            rules: {
                name: string;
                level: string;
                target: string;
            }[];
        };
        http: {
            middlewares: import("connect").NextHandleFunction[];
            AcceptHeaders: number;
            cookie: {
                secret: string;
            };
        };
        db: {
            DefaultConnection: string;
            Connections: {
                Debug: {
                    Queries: boolean;
                };
                Driver: string;
                Filename: string;
                Name: string;
                Migration: {
                    Table: string;
                    OnStartup: boolean;
                };
            }[];
        };
    };
}
//# sourceMappingURL=common.d.ts.map