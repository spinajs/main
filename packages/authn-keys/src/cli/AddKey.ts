import { Autoinject } from '@spinajs/di';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log';
import { KeyRegistry } from '@spinajs/authn/contracts';
import type { KeyRegistration } from '@spinajs/authn/contracts';
import { CLI_ACTOR, cliContext, ownerArg, readPublicJwk } from './common.js';

interface AddKeyOptions {
  jwk?: string;
  file?: string;
  kid?: string;
  name?: string;
  expires?: string;
}

/** Services and agents only: a user registers a key with a proof of possession, which the CLI cannot give. */
@Command('authn:key-add', 'Registers an Ed25519 or P-256 public key for a service or an agent')
@Argument({ name: 'ownerType', required: true, description: 'service or agent', choices: ['service', 'agent'] })
@Argument('ownerId', true, 'id of the service or agent')
@Option('--jwk <json>', false, 'the public JWK as JSON')
@Option('--file <path>', false, 'a file with the public JWK (JSON) or a PEM public key')
@Option('--kid <kid>', false, 'key id, 1-64 of [A-Za-z0-9._-]; default: the RFC 7638 thumbprint')
@Option('--name <name>', false, 'label, up to 128 characters')
@Option('--expires <iso>', false, 'ISO 8601 expiry instant with Z or an offset')
export class AddKey extends CliCommand {
  @Logger('authn-keys')
  protected Log: Log;

  @Autoinject(KeyRegistry)
  protected Registry: KeyRegistry;

  public async execute(ownerType: string, ownerId: string, options: AddKeyOptions): Promise<void> {
    const owner = ownerArg(ownerType, ownerId);
    if (owner.type === 'user') {
      throw new Error('a user registers a key with a proof of possession, through POST /user/keys');
    }
    const expiresAt = options.expires === undefined ? undefined : new Date(options.expires);
    // Without a zone, Date reads the time as local, which differs per host.
    if (expiresAt !== undefined && (Number.isNaN(expiresAt.getTime()) || !/T.*(Z|[+-]\d{2}:?\d{2})$/i.test(options.expires!))) {
      throw new Error(`--expires is not an ISO 8601 instant with Z or an offset: ${options.expires}`);
    }
    const reg = {
      owner,
      actor: CLI_ACTOR,
      jwk: readPublicJwk(options),
      ...(options.kid !== undefined ? { kid: options.kid } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    } as KeyRegistration;
    const r = await this.Registry.register(reg, cliContext());
    if (!r.ok) {
      throw new Error(`key not registered: ${r.code}`);
    }
    this.Log.success(`Key registered: kid ${r.key.kid}, ${r.key.alg}, thumbprint ${r.key.thumbprint}`);
  }
}
