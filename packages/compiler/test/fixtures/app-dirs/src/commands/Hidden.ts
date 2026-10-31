import { CliCommand, Command } from '@spinajs/cli';

@Command('hidden', 'Fixture command')
class HiddenCommand extends CliCommand {
  public async execute(): Promise<void> {}
}

void HiddenCommand;
