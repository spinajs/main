import { userInfo } from 'os';
import { CliCommand } from '@spinajs/cli';
import { Config } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import {
  errorCodeFor,
  exitCodeForError,
  InvalidRunParams,
  RunConflict,
  SchedulerService,
  TriggeredBy,
} from '../contract.js';
import { resolveSchedulerConfig, SchedulerConfig } from '../interfaces.js';
// The CLI imports command files one by one, never the package index, so the runtime
// registrations the service needs are pulled in here.
import '../service/DefaultSchedulerService.js';
import '../time/db-time.js';

/**
 * Base of the `scheduler:*` commands. Output is the command's product, so it goes to stdout with
 * `console.log` (like orm-cli's `migrate-status`): a log level must not swallow it. Exit codes come
 * only from the contract helpers; `@spinajs/cli` exits with `process.exitCode`.
 */
export abstract class SchedulerCommand extends CliCommand {
  @Config('scheduler', { defaultValue: {} })
  protected RawConfig: Partial<SchedulerConfig>;

  protected async service(): Promise<SchedulerService> {
    // the cli resolves only the command; resolving the Orm applies the Migration.OnStartup migrations
    await (await DI.resolve(Orm)).Migrator.ready();
    return DI.resolve(SchedulerService);
  }

  protected config(): SchedulerConfig {
    return resolveSchedulerConfig(this.RawConfig);
  }

  protected print(line = ''): void {
    console.log(line);
  }

  /** Set while a command streams events as JSON lines, so every document it prints is one line (NDJSON). */
  protected jsonLines = false;

  protected json(value: unknown): void {
    console.log(this.jsonLines ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  }

  /** Recorded as `system:cli` with the OS user as the name. */
  protected principal(): TriggeredBy {
    let name: string | undefined;
    try {
      name = userInfo().username;
    } catch {
      name = undefined;
    }
    return { kind: 'system', id: 'cli', ...(name ? { name } : {}) };
  }

  protected fail(err: unknown, asJson: boolean): void {
    process.exitCode = exitCodeForError(err);
    const message = err instanceof Error ? err.message : String(err);
    if (asJson) {
      const extra = {
        ...(err instanceof RunConflict ? { runId: err.runId } : {}),
        ...(err instanceof InvalidRunParams ? { errors: err.errors } : {}),
      };
      this.json({ error: { code: errorCodeFor(err), message, ...extra } });
      return;
    }
    console.error(`error: ${message}`);
    if (err instanceof InvalidRunParams)
      for (const e of err.errors) console.error(`  ${e.path || '(root)'}: ${e.message}`);
    if (err instanceof RunConflict && err.runId) console.error(`  blocking run: ${err.runId}`);
  }

  protected async guard(asJson: boolean, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.fail(err, asJson);
    }
  }
}
