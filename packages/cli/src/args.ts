import { DI } from '@spinajs/di';
import { stripFrameworkOptions } from './argv.js';
import { CLI_ARGV_PROVIDER } from './tokens.js';

/**
 * Argv provider of the `spinajs` bin. Used internally.
 */
DI.register(() => stripFrameworkOptions(process.argv)).asToken(CLI_ARGV_PROVIDER);
