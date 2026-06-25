/**
 * The built-in variables, each resolved through format().
 *
 * Built-ins are registered in the DI container via `@Injectable(ConfigVariable)`
 * and are available to every format() call without passing anything in.
 *
 * Run:
 *   npx ts-node examples/02-builtin-variables.ts
 */
import { format } from '@spinajs/configuration-common';

// Date / time (luxon format strings via the :option part) -------------------
console.log(format(null, 'datetime : ${datetime}'));
console.log(format(null, 'date     : ${date:yyyy-MM-dd}'));
console.log(format(null, 'time     : ${time:HH:mm:ss}'));

// UTC variants --------------------------------------------------------------
console.log(format(null, 'utcdate  : ${utcdate:yyyy-MM-dd}'));
console.log(format(null, 'utctime  : ${utctime:HH:mm:ss}'));

// Unix epoch — milliseconds by default, seconds with :s ---------------------
console.log(format(null, 'ts (ms)  : ${timestamp}'));
console.log(format(null, 'ts (s)   : ${timestamp:s}'));

// Environment & filesystem paths --------------------------------------------
process.env.GREETING = 'hi';
console.log(format(null, 'env      : ${env:GREETING}'));
console.log(format(null, 'temp dir : ${path:temp}'));
console.log(format(null, 'home dir : ${path:home}'));
console.log(format(null, 'cwd      : ${path:cwd}'));
// cross-platform user dirs (Windows AppData / macOS ~/Library / XDG on Linux)
console.log(format(null, 'config   : ${path:config}'));
console.log(format(null, 'data     : ${path:data}'));
console.log(format(null, 'cache    : ${path:cache}'));

// Machine / process identity ------------------------------------------------
console.log(format(null, 'host     : ${hostname}'));
console.log(format(null, 'user     : ${user}'));
console.log(format(null, 'platform : ${platform}/${arch}'));
console.log(format(null, 'pid      : ${pid}'));
console.log(format(null, 'cwd var  : ${cwd}'));

// A fresh random identifier on every call -----------------------------------
console.log(format(null, 'uuid     : ${uuid}'));
