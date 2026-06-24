import { DI } from '@spinajs/di';

/**
 * Framework options eg. to set current app or env.
 * They are consumed directly from process.argv by the configuration
 * module, so we strip them here before handing argv to commander
 * (otherwise commander treats them as unknown options).
 *
 * Used internally.
 */
const SPINAJS_ARGV_OPTIONS = ['--app', '--env', '--apppath'];

DI.register(() => {
  const result: string[] = [];

  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];

    // `--app=foo` style: single token, just drop it
    if (SPINAJS_ARGV_OPTIONS.some((o) => arg.startsWith(`${o}=`))) {
      continue;
    }

    // `--app foo` style: drop the option and its following value (if present)
    if (SPINAJS_ARGV_OPTIONS.includes(arg)) {
      i++;
      continue;
    }

    result.push(arg);
  }

  return result;
}).as('__cli_argv_provider__');
