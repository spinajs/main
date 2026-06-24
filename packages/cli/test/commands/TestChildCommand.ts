import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command({ nameAndArgs: 'child-cmd', description: 'child command', parent: 'parent-cmd' })
export class TestChildCommand extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
