import { StringDecoder } from 'node:string_decoder';
import { DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { IdentityStore, PasswordService } from '@spinajs/authn/contracts';
import type { PrincipalRef } from '@spinajs/authn/contracts';

import { LocalPasswordPolicy } from '../policy.js';

const CLI_ACTOR: PrincipalRef = { type: 'service', id: 'cli' };

export interface SetUserPasswordOptions {
  readonly generate?: boolean;
}

/** The first line, without its line ending and nothing else removed: passwords are never trimmed (D5). */
export async function readPasswordLine(input: NodeJS.ReadableStream): Promise<string> {
  const decoder = new StringDecoder('utf8');
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    const end = text.indexOf('\n');
    if (end >= 0) {
      text = text.slice(0, end);
      return text.endsWith('\r') ? text.slice(0, -1) : text;
    }
  }
  text += decoder.end();
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/**
 * Sets a password through `PasswordService.set` (D17). The password comes from stdin or `--generate`, never from an argument,
 * which would stay in the shell history.
 */
@Command('authn:password', 'Sets the password of an identity; reads it from the first stdin line unless --generate is given')
@Argument('login', true, 'login of the identity')
@Option('-g, --generate', false, 'generate a password and print it once')
export class SetUserPassword extends CliCommand {
  @Logger('authn-local')
  protected Log: Log;

  public async execute(login: string, options: SetUserPasswordOptions): Promise<void> {
    const id = await DI.resolve(IdentityStore).findByLogin(login);
    if (!id) {
      this.Log.error('No identity has this login; no password was set');
      return;
    }

    const generated = options.generate === true;
    const password = generated ? DI.resolve(LocalPasswordPolicy).generate() : await readPasswordLine(this.input());
    const service = await DI.resolve(PasswordService);
    const result = await service.set(id, password, { now: new Date(), purpose: 'request' }, { actor: CLI_ACTOR });
    if (result.status === 'rejected') {
      this.Log.error(`The password was rejected (${result.violations.join(', ')}); the stored password is unchanged`);
      return;
    }

    this.Log.success(`Password set for ${id.type} ${id.id}`);
    if (generated) {
      // Straight to stdout, not the logger: log targets may persist it.
      this.print(`Password (copy it now, it is not shown again): ${password}\n`);
    }
  }

  protected input(): NodeJS.ReadableStream {
    return process.stdin;
  }

  protected print(text: string): void {
    process.stdout.write(text);
  }
}
