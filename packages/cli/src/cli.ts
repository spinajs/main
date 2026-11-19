#!/usr/bin/env node
import { DI } from '@spinajs/di';
import { Cli, CommanderError } from './index.js';
import { runPendingBootstrappers } from './bootstrappers.js';
import { Configuration } from '@spinajs/configuration-common';
import { resolveCliLog } from './cliLog.js';
import { Log, setLogStdoutStream } from '@spinajs/log-common';
import './args.js';

/** Writes to a pipe or a Windows console are asynchronous; process.exit() would cut off what is still queued. */
async function exit(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((resolve) => s.write('', () => resolve()))));
  process.exit(code);
}

async function cli() {
  DI.setESMModuleSupport();

  // stdout carries a command's own output ( a status table, a JSON document ) that scripts read
  setLogStdoutStream('stderr');

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
    await exit(process.exitCode ?? 0);
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
    await exit(-1);
  }
}

void cli();
