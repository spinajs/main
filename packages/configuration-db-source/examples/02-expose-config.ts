/**
 * Exposing a config value to the database.
 *
 * Marking a `@Config` property with `expose: true` makes the framework insert a
 * row for it into the `configuration` table (InsertOrIgnore - existing rows are
 * left untouched, so a value edited in the db survives restarts). The row is
 * inserted once the ORM resolves; the stored value is then loaded back into the
 * live configuration.
 *
 * This lets you ship a sensible default in code while allowing the value to be
 * administered from the database.
 *
 * Run:
 *   node lib/mjs/examples/02-expose-config.js
 */
import { Config } from '@spinajs/configuration';
import '@spinajs/configuration-db-source';

export class MailService {
  /**
   * Stored at Slug `mailer.fromAddress`. `group` / `label` / `description` are
   * metadata for an admin UI - they do NOT affect the config path, which is
   * always the Slug (the first `@Config` argument).
   */
  @Config('mailer.fromAddress', {
    defaultValue: 'no-reply@example.com',
    required: true,
    expose: true,
    exposeOptions: {
      type: 'string',
      group: 'mailer',
      label: 'From address',
      description: 'Default From: address for outgoing mail',
    },
  })
  protected FromAddress: string;

  /**
   * A numeric option. `type: 'number'` controls how the db text is converted
   * back into a value (here, an integer).
   */
  @Config('mailer.maxRetries', {
    defaultValue: 3,
    expose: true,
    exposeOptions: {
      type: 'number',
      group: 'mailer',
      label: 'Max retries',
    },
  })
  protected MaxRetries: number;

  public describe(): string {
    return `from=${this.FromAddress} retries=${this.MaxRetries}`;
  }
}
