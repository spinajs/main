/* eslint-disable no-console */
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { EmailVerification } from '../service.js';

/** Prints `domain <domain>`, then `<verifier> <result> [reason] [source] [error]` per verifier. */
@Command('email-verification:check', "Prints every verifier's live answer for an address; reads no cache and writes none")
@Argument('email', true, 'address to check')
export class CheckEmail extends CliCommand {
  @Autoinject(EmailVerification)
  protected Verification: EmailVerification;

  public async execute(email: string): Promise<void> {
    const { domain, outcomes } = await this.Verification.explain(email);
    console.log(`domain ${domain ?? '(invalid)'}`);
    for (const o of outcomes) {
      console.log([o.verifier, o.verdict.result, o.verdict.reason, o.verdict.source, o.error].filter((x) => x !== undefined).join(' '));
    }
  }
}
