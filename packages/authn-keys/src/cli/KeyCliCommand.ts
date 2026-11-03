import { CliCommand } from '@spinajs/cli';

/** Base of the `authn:key-*` commands. The KeyStore behind KeyRegistry boots the Orm it queries; that boot fails while a migration is pending (run migrate-up first). */
export abstract class KeyCliCommand extends CliCommand {}
