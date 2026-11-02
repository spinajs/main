#!/usr/bin/env node
import { Bootstrapper, DI } from '@spinajs/di';
import { Cli } from './index.js';
import { Configuration } from '@spinajs/configuration-common';
import { reportFatal, resolveCliLog } from './cliLog.js';
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
    await reportFatal(err);
    process.exit(-1);
  }
}

void cli();
