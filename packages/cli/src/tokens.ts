import { token } from '@spinajs/di';
import type { CliCommand } from './interfaces.js';

/** Command classes registered by `@Command`. */
export const CLI_COMMAND = token<CliCommand>('__cli_command__');

/** Factory of the arguments the `spinajs` bin runs with, framework options stripped. */
export const CLI_ARGV_PROVIDER = token<string[] | null>('__cli_argv_provider__');
