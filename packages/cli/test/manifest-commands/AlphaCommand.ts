import { Command } from '../../src/decorators.js';
import { CliCommand } from '../../src/interfaces.js';

@Command('manifest-alpha', 'listed from the manifest')
export class AlphaCommand extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
