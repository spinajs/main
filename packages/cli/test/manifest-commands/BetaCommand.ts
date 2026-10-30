import { Command } from '../../src/decorators.js';
import { CliCommand } from '../../src/interfaces.js';

@Command('manifest-beta', 'listed from the manifest')
export class BetaCommand extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
