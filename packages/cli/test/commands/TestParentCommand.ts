import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command({ nameAndArgs: 'parent-cmd', description: 'parent command' })
export class TestParentCommand extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
