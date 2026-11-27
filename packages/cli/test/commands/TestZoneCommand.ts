import { Command, Option } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

/** Declares the option name a hook of the hook tests adds to the program, with a default of its own. */
@Command('zone-command', 'command with its own --zone option')
@Option('--zone <name>', false, 'its own zone', 'cmd-default')
export class TestZoneCommand extends CliCommand {
  public execute(_options: { zone?: string }): Promise<void> {
    return Promise.resolve();
  }
}
