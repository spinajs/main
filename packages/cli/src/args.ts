import { DI } from '@spinajs/di';
import { stripFrameworkOptions } from './argv.js';

/**
 * Argv provider of the `spinajs` bin. Used internally.
 */
DI.register(() => stripFrameworkOptions(process.argv)).as('__cli_argv_provider__');
