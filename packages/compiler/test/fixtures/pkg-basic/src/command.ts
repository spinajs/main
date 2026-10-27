import { Command, Option, Argument, CliCommand } from '@spinajs/cli';

@Command('basic:hello <name>', 'Say hello')
@Option('-l, --loud', false, 'Shout')
@Argument('name', true, 'Who to greet')
export class HelloCommand extends CliCommand { public async execute(): Promise<void> {} }

@Command({ nameAndArgs: 'basic:bye', description: 'Say bye', parent: 'basic:hello', aliases: ['b'] })
export class ByeCommand extends CliCommand { public async execute(): Promise<void> {} }
