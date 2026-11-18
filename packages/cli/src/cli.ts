#!/usr/bin/env node
import { DI } from '@spinajs/di';
import { Cli, CommanderError } from './index.js';
import { runPendingBootstrappers } from './bootstrappers.js';
import { Configuration } from '@spinajs/configuration-common';
import { resolveCliLog } from './cliLog.js';
import { Log } from '@spinajs/log-common';
import './args.js';

async function cli() {
  DI.setESMModuleSupport();

  let log: Log | undefined;

  try {
    const ran = new Set<object>();

    // Bootstrappers register the configuration schemas; the Configuration applies them when it boots.
    await runPendingBootstrappers(ran);

    await DI.resolve(Configuration);

    // The config files are imported while the Configuration boots, and the modules they import register bootstrappers too.
    await runPendingBootstrappers(ran);

    log = resolveCliLog();

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
    // commander errors are already routed through the framework logger via
    // configureOutput; only log other failures (eg. bootstrap errors) here to
    // avoid a duplicate line.
    if (!(err instanceof CommanderError)) {
      if (log) {
        log.error((err as Error).message);
      } else {
        // no logger before the configuration has loaded
        console.error(err);
      }
    }
    process.exit(-1);
  }
}

void cli();
