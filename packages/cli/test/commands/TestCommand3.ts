import { Command, Argument } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command('test-command3', 'optional arg command')
@Argument('count', false, 'how many', 5, (a: string) => parseInt(a))
export class TestCommand3 extends CliCommand {
  public execute(_count: number): Promise<void> {
    return Promise.resolve();
  }
}
