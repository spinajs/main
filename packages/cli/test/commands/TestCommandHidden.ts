import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command('hidden-cmd', 'hidden command', { hidden: true })
export class TestCommandHidden extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
