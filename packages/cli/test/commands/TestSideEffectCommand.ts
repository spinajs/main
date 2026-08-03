import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

/**
 * Counts its own instantiations so tests can assert that commands are only
 * resolved when actually invoked — constructing a command may have heavy
 * side effects in real apps (eg. opening database connections).
 */
@Command('side-effect-cmd', 'command counting its instantiations')
export class TestSideEffectCommand extends CliCommand {
  public static instantiations = 0;

  constructor() {
    super();
    TestSideEffectCommand.instantiations++;
  }

  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
