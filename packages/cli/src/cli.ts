#!/usr/bin/env node
import { Bootstrapper, DI } from '@spinajs/di';
import { Cli, CommanderError } from './index.js';
import { Configuration } from '@spinajs/configuration-common';
import { resolveCliLog } from './cliLog.js';
import { Log } from '@spinajs/log-common';
import './args.js';

async function cli() {
  try {
    // Bootstrappers register the configuration schemas; the Configuration applies them when it boots.
    const bootstrappers = DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);

    const log = resolveCliLog();

    log.success('Welcome to spinajs cli...');

    await DI.resolve(Cli);

    // force process exit
    // TODO: could couse bug becouse process will be forced to exit
    // immediatelly
    //
    // Honour process.exitCode rather than hardcoding 0: a command that reports a
    // condition instead of failing ( eg. `migrate-status` setting 1 when migrations
    // are pending or failed, so CI can gate on it ) has no other way to say so.
    // process.exit() ignores an already-assigned exitCode unless it is passed in.
    process.exit(process.exitCode ?? 0);
  } catch (err) {
    // Commander errors already went through the framework logger when one is registered. Anything else is printed
    // here: until a command loads @spinajs/log this entry point logs to a buffering proxy, and process.exit() drops it.
    if (!(err instanceof CommanderError && DI.check(Log))) {
      console.error(err);
    }
    process.exit(-1);
  }
}

void cli();
