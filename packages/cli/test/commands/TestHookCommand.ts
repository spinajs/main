import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command({ nameAndArgs: 'hook-cmd', description: 'hook command' })
export class TestHookCommand extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }

  public onPreAction(): void {
    // overridden so the hook has something to spy on
  }

  public onPostAction(): void {
    // overridden so the hook has something to spy on
  }
}
