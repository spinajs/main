import { CliCommand, Command } from '@spinajs/cli';

@Command('basic', 'Basic fixture command')
export class BasicCommand extends CliCommand {
  public async execute(): Promise<void> {}
}
