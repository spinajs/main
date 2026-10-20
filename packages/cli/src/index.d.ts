import { CliCommand } from './interfaces.js';
import { AsyncService, ClassInfo } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { Configuration } from '@spinajs/configuration';
export * from './interfaces.js';
export * from './decorators.js';
export * from './commander.js';
export declare class Cli extends AsyncService {
    protected Log: Log;
    protected Configuration: Configuration;
    /**
     * Commands are only LISTED here, never instantiated up front. Instantiation
     * is deferred until a command is actually invoked: constructing a command may
     * have heavy side effects ( eg. `@Autoinject() Orm` opening a database
     * connection ), and eager resolution would make every CLI run — including
     * ones that don't need those services, like cache generation during a docker
     * image build — fail when a dependency is unavailable.
     */
    Commands: Promise<Array<ClassInfo<CliCommand>>>;
    /**
     * Soft, optional i18n of help text. `@spinajs/intl` installs a global `__`
     * translator when present and configured; when it isn't, this is a no-op so
     * the package carries no hard dependency on intl.
     */
    protected translate(text?: string): string;
    resolve(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map