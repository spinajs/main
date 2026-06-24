import { Command, Option } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

interface AdvOptions {
  aaa?: boolean;
  bbb?: boolean;
  cheese?: string | boolean;
  sauce?: boolean;
}

@Command('adv-cmd', 'advanced options command')
@Option({ flags: '-a, --aaa', required: false, conflicts: 'bbb' })
@Option({ flags: '-b, --bbb', required: false })
@Option({ flags: '-c, --cheese [type]', required: false, preset: 'cheddar' })
@Option('--no-sauce', false, 'remove sauce')
export class TestCommandAdvOpts extends CliCommand {
  public execute(_options: AdvOptions): Promise<void> {
    return Promise.resolve();
  }
}
