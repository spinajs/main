import { CliCommand, Command } from '@spinajs/cli';

@Command('kept', 'Fixture command')
export class KeptCommand extends CliCommand {
  public async execute(): Promise<void> {}
}
