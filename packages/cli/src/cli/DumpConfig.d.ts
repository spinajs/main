import { Log } from '@spinajs/log-common';
import { CliCommand } from '../index.js';
import { Configuration } from '@spinajs/configuration-common';
interface DumpConfigOptions {
    path?: string;
}
export declare class DumpConfiguration extends CliCommand {
    protected Log: Log;
    protected Config: Configuration;
    execute(options: DumpConfigOptions): Promise<void>;
}
export {};
//# sourceMappingURL=DumpConfig.d.ts.map