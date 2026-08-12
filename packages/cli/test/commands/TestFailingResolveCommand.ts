import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

/**
 * Simulates a command whose service resolution fails because a dependency is
 * unavailable (eg. a database connection). Its presence must not prevent
 * other commands from running.
 */
@Command('failing-resolve-cmd', 'command whose resolution always fails')
export class TestFailingResolveCommand extends CliCommand {
  public async resolve(): Promise<void> {
    throw new Error('simulated unavailable dependency (eg. database)');
  }

  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
