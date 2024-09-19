import { DI } from '@spinajs/di';

/**
 * Framework options eg. to set current app or env
 * Used internal
 */
const SPINAJS_ARGV_OPTIONS = ['--app', '--env'];

DI.register(() => {
  let args = process.argv;

  for (const o of SPINAJS_ARGV_OPTIONS) {
    if (args.indexOf(o) !== -1) {

        // remove option
        args.splice(process.argv.indexOf(o), 2);
    }
  }

  return args;
}).as('__cli_argv_provider__');
