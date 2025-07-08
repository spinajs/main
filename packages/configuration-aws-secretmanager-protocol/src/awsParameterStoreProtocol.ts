import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { Injectable, Singleton } from '@spinajs/di';

@Singleton()
@Injectable(ConfigVarProtocol)
export class AwsSecretsManagerVarProtocol extends ConfigVarProtocol {
    protected Client: SSMClient;

    get Protocol(): string {
        return 'aws-parameters://';
    }

    public async getVar(path: string, configuration: any): Promise<unknown> {
        if (!this.Client) {
            this.Client = new SSMClient({
                ...configuration?.aws?.parameterStore,
                logger: {
                    trace: (msg: any) => InternalLogger.trace(msg, 'AwsParameterStoreVarProtocol'),
                    debug: (msg: any) => InternalLogger.debug(msg, 'AwsParameterStoreVarProtocol'),
                    info: (msg: any) => InternalLogger.info(msg, 'AwsParameterStoreVarProtocol'),
                    warn: (msg: any) => InternalLogger.warn(msg, 'AwsParameterStoreVarProtocol'),
                    error: (msg: any) => InternalLogger.error(msg, 'AwsParameterStoreVarProtocol'),
                },
            });
        }

        const command = new GetParameterCommand({
            Name: path,
            WithDecryption: true, // Set to false if it's not a SecureString
        });

        const response = await this.Client.send(command);


        InternalLogger.info(`Obtained config value for ${path} from AWS Parameter store`, 'Configuration');

        return response.Parameter?.Value || "";
    }
}
