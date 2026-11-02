import { CliCommand, Command } from '@spinajs/cli';

@Command('elsewhere', 'Fixture command')
export class ElsewhereCommand extends CliCommand {
  public async execute(): Promise<void> {}
}
