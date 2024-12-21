import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Injectable, Singleton } from '@spinajs/di';

@Singleton()
@Injectable(ConfigVarProtocol)
export class AwsSecretsManagerVarProtocol extends ConfigVarProtocol {
  protected Client: SecretsManagerClient;

  get Protocol(): string {
    return 'aws://';
  }

  public async getVar(path: string, configuration: any): Promise<unknown> {
    if (!this.Client) {
      this.Client = new SecretsManagerClient({
        ...configuration?.aws?.secretsManager,
        logger: {
          trace: (msg: any) => InternalLogger.trace(msg, 'AwsSecretsManagerVarProtocol'),
          debug: (msg: any) => InternalLogger.debug(msg, 'AwsSecretsManagerVarProtocol'),
          info: (msg: any) => InternalLogger.info(msg, 'AwsSecretsManagerVarProtocol'),
          warn: (msg: any) => InternalLogger.warn(msg, 'AwsSecretsManagerVarProtocol'),
          error: (msg: any) => InternalLogger.error(msg, 'AwsSecretsManagerVarProtocol'),
        },
      });
    }

    const response = await this.Client.send(
      new GetSecretValueCommand({
        SecretId: path,
        VersionStage: 'AWSCURRENT',
      }),
    );

    InternalLogger.info(`Obtained config value for ${path} from AWS Secrets manager `, 'Configuration');

    return response.SecretString;
  }
}
