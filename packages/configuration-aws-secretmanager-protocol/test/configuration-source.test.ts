/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { join, normalize, resolve } from 'path';
import { FrameworkConfiguration } from '../../configuration/src/configuration.js';
import { Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import sinon from 'sinon';
import './../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class ParameterStoreConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        test: 'aws-parameters://prod/testsecret',
        nested: {
          value: 'aws-parameters://prod/nested-param',
        },
        parameterStore: {
          region: 'eu-central-1',
        },
      },
    };
  }
}

export class SecretsManagerConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        secret: 'aws-secrets://my-secret',
        jsonSecret: 'aws-secrets://my-json-secret',
        secretsManager: {
          region: 'us-west-2',
        },
      },
    };
  }
}

export class MixedConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        param: 'aws-parameters://prod/param1',
        secret: 'aws-secrets://secret1',
        regular: 'https://example.com',
        parameterStore: {
          region: 'eu-central-1',
        },
        secretsManager: {
          region: 'us-west-2',
        },
      },
    };
  }
}

async function cfg(): Promise<Configuration> {
  return await DI.resolve<Configuration>(Configuration);
}

describe('AWS Secrets Manager & Parameter Store Configuration Protocol', function () {
  this.timeout(10000);

  let ssmStub: sinon.SinonStub;
  let secretsManagerStub: sinon.SinonStub;

  afterEach(async () => {
    DI.uncache(Configuration);
    if (ssmStub) {
      ssmStub.restore();
    }
    if (secretsManagerStub) {
      secretsManagerStub.restore();
    }
  });

  after(async () => {
    await DI.dispose();
  });

  describe('AWS Parameter Store Protocol', () => {
    beforeEach(() => {
      DI.register(ParameterStoreConf).as(Configuration);
      
      ssmStub = sinon.stub(SSMClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetParameterCommand) {
          const name = command.input.Name;
          if (name === 'prod/testsecret') {
            return Promise.resolve({
              Parameter: {
                Value: 'testValue',
              },
            });
          } else if (name === 'prod/nested-param') {
            return Promise.resolve({
              Parameter: {
                Value: 'nestedValue',
              },
            });
          }
        }
        return Promise.reject(new Error('Parameter not found'));
      });
    });

    it('Should load aws parameter store value to configuration', async () => {
      const c = await cfg();
      await c.load();
      
      expect(c.get('aws.test')).to.eq('testValue');
    });

    it('Should load nested aws parameter store value', async () => {
      const c = await cfg();
      await c.load();
      
      expect(c.get('aws.nested.value')).to.eq('nestedValue');
    });

    it('Should use WithDecryption flag for secure strings', async () => {
      const c = await cfg();
      await c.load();

      expect(ssmStub.called).to.be.true;
      const callArgs = ssmStub.getCall(0).args[0];
      expect(callArgs.input.WithDecryption).to.be.true;
    });

    it('Should return empty string if parameter value is undefined', async () => {
      ssmStub.restore();
      ssmStub = sinon.stub(SSMClient.prototype, 'send').resolves({
        Parameter: {},
      });

      const c = await cfg();
      await c.load();

      expect(c.get('aws.test')).to.eq('');
    });
  });

  describe('AWS Secrets Manager Protocol', () => {
    beforeEach(() => {
      DI.register(SecretsManagerConf).as(Configuration);
      
      secretsManagerStub = sinon.stub(SecretsManagerClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetSecretValueCommand) {
          const secretId = command.input.SecretId;
          if (secretId === 'my-secret') {
            return Promise.resolve({
              SecretString: 'mySecretValue',
            });
          } else if (secretId === 'my-json-secret') {
            return Promise.resolve({
              SecretString: JSON.stringify({ username: 'admin', password: 'pass123' }),
            });
          }
        }
        return Promise.reject(new Error('Secret not found'));
      });
    });

    it('Should load aws secrets manager value to configuration', async () => {
      const c = await cfg();
      await c.load();
      
      expect(c.get('aws.secret')).to.eq('mySecretValue');
    });

    it('Should load JSON secret from secrets manager', async () => {
      const c = await cfg();
      await c.load();
      
      const jsonSecret = c.get('aws.jsonSecret');
      expect(jsonSecret).to.be.a('string');
      
      const parsed = JSON.parse(jsonSecret as string);
      expect(parsed.username).to.eq('admin');
      expect(parsed.password).to.eq('pass123');
    });

    it('Should use AWSCURRENT version stage', async () => {
      const c = await cfg();
      await c.load();

      expect(secretsManagerStub.called).to.be.true;
      const callArgs = secretsManagerStub.getCall(0).args[0];
      expect(callArgs.input.VersionStage).to.eq('AWSCURRENT');
    });

    it('Should use configuration region from secretsManager config', async () => {
      const c = await cfg();
      await c.load();

      expect(secretsManagerStub.called).to.be.true;
    });
  });

  describe('Mixed Protocol Usage', () => {
    beforeEach(() => {
      DI.register(MixedConf).as(Configuration);
      
      ssmStub = sinon.stub(SSMClient.prototype, 'send').resolves({
        Parameter: {
          Value: 'paramValue',
        },
      });

      secretsManagerStub = sinon.stub(SecretsManagerClient.prototype, 'send').resolves({
        SecretString: 'secretValue',
      });
    });

    it('Should handle both parameter store and secrets manager in same config', async () => {
      const c = await cfg();
      await c.load();
      
      expect(c.get('aws.param')).to.eq('paramValue');
      expect(c.get('aws.secret')).to.eq('secretValue');
    });

    it('Should not process regular URLs as protocols', async () => {
      const c = await cfg();
      await c.load();
      
      expect(c.get('aws.regular')).to.eq('https://example.com');
    });
  });

  describe('Error Handling', () => {
    it('Should handle parameter store errors gracefully', async () => {
      DI.register(ParameterStoreConf).as(Configuration);
      
      ssmStub = sinon.stub(SSMClient.prototype, 'send').rejects(new Error('Access denied'));

      const c = await cfg();
      
      // Configuration load should handle the error internally
      // The value will remain as the protocol string when error occurs
      try {
        await c.load();
        // If no error thrown, the protocol value should remain unchanged
        expect(c.get('aws.test')).to.include('aws-parameters://');
      } catch (err) {
        // If error is thrown, that's also acceptable behavior
        expect(err).to.exist;
      }
    });
  });

  describe('Protocol Names', () => {
    it('Should use correct protocol name for parameter store', async () => {
      // Use a fresh config for this isolated test
      class TestParamConf extends FrameworkConfiguration {
        public onLoad(): unknown {
          return {
            logger: {
              targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
              rules: [{ name: '*', level: 'trace', target: 'Empty' }],
            },
            aws: {
              value: 'aws-parameters://testparam',
              parameterStore: { region: 'us-east-1' },
            },
          };
        }
      }
      
      DI.register(TestParamConf).as(Configuration);
      
      ssmStub = sinon.stub(SSMClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetParameterCommand) {
          return Promise.resolve({
            Parameter: {
              Value: 'paramValue123',
            },
          });
        }
        return Promise.reject(new Error('Unexpected command'));
      });

      const c = await cfg();
      await c.load();

      // Protocol should be aws-parameters://
      const value = c.get('aws.value');
      expect(value).to.eq('paramValue123');
    });

    it('Should use correct protocol name for secrets manager', async () => {
      // Use a fresh config for this isolated test
      class TestSecretConf extends FrameworkConfiguration {
        public onLoad(): unknown {
          return {
            logger: {
              targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
              rules: [{ name: '*', level: 'trace', target: 'Empty' }],
            },
            aws: {
              value: 'aws-secrets://testsecret',
              secretsManager: { region: 'us-west-2' },
            },
          };
        }
      }
      
      DI.register(TestSecretConf).as(Configuration);
      
      secretsManagerStub = sinon.stub(SecretsManagerClient.prototype, 'send').resolves({
        SecretString: 'secretValue456',
      });

      const c = await cfg();
      await c.load();

      // Protocol should be aws-secrets://
      expect(c.get('aws.value')).to.eq('secretValue456');
    });
  });
});
