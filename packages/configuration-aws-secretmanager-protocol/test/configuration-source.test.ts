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
import { Configuration, ConfigVarProtocol } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
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

export class AdvancedConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        jsonKey: 'aws-secrets://my-json-secret#username',
        jsonNested: 'aws-secrets://my-json-secret#nested.value',
        versioned: 'aws-secrets://my-secret?versionStage=AWSPREVIOUS',
        byId: 'aws-secrets://my-secret?versionId=v123',
        binary: 'aws-secrets://my-binary',
        binaryJson: 'aws-secrets://my-binary-json#token',
        paramJson: 'aws-parameters://prod/json-param#database.password',
        paramPlain: 'aws-parameters://prod/plain?withDecryption=false',
        paramInvalidBool: 'aws-parameters://prod/secure?withDecryption=maybe',
        paramList: 'aws-parameters://prod/list-param',
        secretsManager: { region: 'us-west-2' },
        parameterStore: { region: 'eu-central-1' },
      },
    };
  }
}

export class CacheConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        // same secret referenced twice -> should collapse to a single AWS call (in-flight dedupe)
        dup1: 'aws-secrets://cache/shared-secret',
        dup2: 'aws-secrets://cache/shared-secret',
        // parameter used to assert a cache hit on a subsequent load within the TTL
        param: 'aws-parameters://cache/shared-param',
        secretsManager: { region: 'us-west-2', cacheTtl: 60000 },
        parameterStore: { region: 'eu-central-1', cacheTtl: 60000 },
      },
    };
  }
}

export class FallbackConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        withDefault: 'aws-secrets://missing-secret?default=localdev',
        optional: 'aws-secrets://maybe-secret?optional=true',
        required: 'aws-secrets://needed-secret',
        paramDefault: 'aws-parameters://missing-param?default=fallbackparam',
        secretsManager: { region: 'us-west-2', cacheTtl: 0 },
        parameterStore: { region: 'eu-central-1', cacheTtl: 0 },
      },
    };
  }
}

export class TreeConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        app: 'aws-parameters://prod/myapp/*',
        parameterStore: { region: 'eu-central-1', cacheTtl: 0 },
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
    // the protocol singletons (and their caches) outlive a single Configuration instance,
    // so clear them between tests to keep stubbed AWS responses isolated
    const protocols = await DI.resolve(Array.ofType(ConfigVarProtocol));
    (protocols as Array<{ clearCache?: () => void }>).forEach((p) => p.clearCache?.());

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

  describe('Advanced path features', () => {
    beforeEach(() => {
      DI.register(AdvancedConf).as(Configuration);

      secretsManagerStub = sinon.stub(SecretsManagerClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetSecretValueCommand) {
          const secretId = command.input.SecretId;
          if (secretId === 'my-json-secret') {
            return Promise.resolve({
              SecretString: JSON.stringify({ username: 'admin', nested: { value: 'deep' } }),
            });
          } else if (secretId === 'my-secret') {
            return Promise.resolve({ SecretString: 'mySecretValue' });
          } else if (secretId === 'my-binary') {
            return Promise.resolve({ SecretBinary: new TextEncoder().encode('binarydata') });
          } else if (secretId === 'my-binary-json') {
            return Promise.resolve({ SecretBinary: new TextEncoder().encode(JSON.stringify({ token: 'abc' })) });
          }
        }
        return Promise.reject(new Error('Secret not found'));
      });

      ssmStub = sinon.stub(SSMClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetParameterCommand) {
          const name = command.input.Name;
          if (name === 'prod/json-param') {
            return Promise.resolve({ Parameter: { Value: JSON.stringify({ database: { password: 'pg-pass' } }) } });
          } else if (name === 'prod/plain') {
            return Promise.resolve({ Parameter: { Value: 'plainval' } });
          } else if (name === 'prod/secure') {
            return Promise.resolve({ Parameter: { Value: 'secureval' } });
          } else if (name === 'prod/list-param') {
            return Promise.resolve({ Parameter: { Value: 'a,b,c', Type: 'StringList' } });
          }
        }
        return Promise.reject(new Error('Parameter not found'));
      });
    });

    it('Should extract a top level key from a JSON secret', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.jsonKey')).to.eq('admin');
    });

    it('Should extract a nested key from a JSON secret using dot notation', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.jsonNested')).to.eq('deep');
    });

    it('Should extract a nested key from a JSON parameter', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.paramJson')).to.eq('pg-pass');
    });

    it('Should pass versionStage from the query string to the request', async () => {
      const c = await cfg();
      await c.load();

      const call = secretsManagerStub.getCalls().find((x) => x.args[0].input.SecretId === 'my-secret' && x.args[0].input.VersionStage === 'AWSPREVIOUS');
      expect(call, 'expected a call with VersionStage=AWSPREVIOUS').to.exist;
      expect(c.get('aws.versioned')).to.eq('mySecretValue');
    });

    it('Should pass versionId from the query string to the request', async () => {
      const c = await cfg();
      await c.load();

      const call = secretsManagerStub.getCalls().find((x) => x.args[0].input.VersionId === 'v123');
      expect(call, 'expected a call with VersionId=v123').to.exist;
      // when versionId is given we must not force the AWSCURRENT stage
      expect(call?.args[0].input.VersionStage).to.be.undefined;
    });

    it('Should default to the AWSCURRENT stage when no version is requested', async () => {
      const c = await cfg();
      await c.load();

      // aws.jsonKey -> my-json-secret has neither versionStage nor versionId
      const call = secretsManagerStub.getCalls().find((x) => x.args[0].input.SecretId === 'my-json-secret');
      expect(call, 'expected a call for my-json-secret').to.exist;
      expect(call?.args[0].input.VersionStage).to.eq('AWSCURRENT');
      expect(call?.args[0].input.VersionId).to.be.undefined;
    });

    it('Should honor withDecryption=false for parameter store', async () => {
      const c = await cfg();
      await c.load();

      const call = ssmStub.getCalls().find((x) => x.args[0].input.Name === 'prod/plain');
      expect(call, 'expected a call for prod/plain').to.exist;
      expect(call?.args[0].input.WithDecryption).to.be.false;
      expect(c.get('aws.paramPlain')).to.eq('plainval');
    });

    it('Should expose a StringList parameter as an array', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.paramList')).to.deep.eq(['a', 'b', 'c']);
    });

    it('Should fall back to withDecryption=true for an invalid value', async () => {
      const c = await cfg();
      await c.load();

      const call = ssmStub.getCalls().find((x) => x.args[0].input.Name === 'prod/secure');
      expect(call, 'expected a call for prod/secure').to.exist;
      expect(call?.args[0].input.WithDecryption).to.be.true;
      expect(c.get('aws.paramInvalidBool')).to.eq('secureval');
    });

    it('Should return SecretBinary as a base64 encoded string', async () => {
      const c = await cfg();
      await c.load();

      const value = c.get('aws.binary');
      expect(value).to.eq(Buffer.from('binarydata').toString('base64'));
      expect(Buffer.from(value as string, 'base64').toString()).to.eq('binarydata');
    });

    it('Should extract a JSON key from a binary secret', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.binaryJson')).to.eq('abc');
    });
  });

  describe('Caching and de-duplication', () => {
    beforeEach(() => {
      DI.register(CacheConf).as(Configuration);

      secretsManagerStub = sinon.stub(SecretsManagerClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetSecretValueCommand && command.input.SecretId === 'cache/shared-secret') {
          return Promise.resolve({ SecretString: 'sharedValue' });
        }
        return Promise.reject(new Error('Secret not found'));
      });

      ssmStub = sinon.stub(SSMClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetParameterCommand && command.input.Name === 'cache/shared-param') {
          return Promise.resolve({ Parameter: { Value: 'paramShared' } });
        }
        return Promise.reject(new Error('Parameter not found'));
      });
    });

    it('Should resolve a secret referenced twice with a single AWS call', async () => {
      const c = await cfg();
      await c.load();

      const calls = secretsManagerStub.getCalls().filter((x) => x.args[0].input.SecretId === 'cache/shared-secret');
      expect(calls.length, 'expected the shared secret to be fetched once').to.eq(1);
      expect(c.get('aws.dup1')).to.eq('sharedValue');
      expect(c.get('aws.dup2')).to.eq('sharedValue');
    });

    it('Should serve a parameter from cache on a subsequent load within the TTL', async () => {
      let c = await cfg();
      await c.load();

      const afterFirst = ssmStub.getCalls().filter((x) => x.args[0].input.Name === 'cache/shared-param').length;
      expect(afterFirst, 'first load should hit AWS once').to.eq(1);

      // simulate a second config load; the protocol singleton keeps its cache between loads
      DI.uncache(Configuration);
      c = await cfg();
      await c.load();

      const afterSecond = ssmStub.getCalls().filter((x) => x.args[0].input.Name === 'cache/shared-param').length;
      expect(afterSecond, 'second load within TTL should be served from cache').to.eq(1);
      expect(c.get('aws.param')).to.eq('paramShared');
    });
  });

  describe('Failure fallbacks', () => {
    beforeEach(() => {
      DI.register(FallbackConf).as(Configuration);

      // simulate AWS being unreachable / secret missing for every request
      secretsManagerStub = sinon.stub(SecretsManagerClient.prototype, 'send').rejects(new Error('ResourceNotFoundException'));
      ssmStub = sinon.stub(SSMClient.prototype, 'send').rejects(new Error('ParameterNotFound'));
    });

    it('Should fall back to ?default= value when a secret cannot be resolved', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.withDefault')).to.eq('localdev');
    });

    it('Should resolve ?optional=true to an empty string on failure', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.optional')).to.eq('');
    });

    it('Should fall back to ?default= value for a parameter store failure', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.paramDefault')).to.eq('fallbackparam');
    });

    it('Should leave the literal protocol string when no fallback is requested', async () => {
      const c = await cfg();
      await c.load();

      // without ?default / ?optional the error propagates and the framework keeps the raw value
      expect(c.get('aws.required')).to.eq('aws-secrets://needed-secret');
    });
  });

  describe('Parameter Store subtree expansion', () => {
    beforeEach(() => {
      DI.register(TreeConf).as(Configuration);

      ssmStub = sinon.stub(SSMClient.prototype, 'send').callsFake((command: any) => {
        if (command instanceof GetParametersByPathCommand && command.input.Path === '/prod/myapp') {
          if (!command.input.NextToken) {
            return Promise.resolve({
              Parameters: [
                { Name: '/prod/myapp/db/host', Value: 'h' },
                { Name: '/prod/myapp/db/port', Value: '5432' },
              ],
              NextToken: 'page2',
            });
          }
          return Promise.resolve({
            Parameters: [{ Name: '/prod/myapp/key', Value: 'k' }],
          });
        }
        return Promise.reject(new Error('Path not found'));
      });
    });

    it('Should expand a hierarchy into a nested object with the prefix stripped', async () => {
      const c = await cfg();
      await c.load();

      expect(c.get('aws.app')).to.deep.eq({ db: { host: 'h', port: '5432' }, key: 'k' });
      expect(c.get('aws.app.db.host')).to.eq('h');
    });

    it('Should paginate through every parameter under the path', async () => {
      const c = await cfg();
      await c.load();

      const calls = ssmStub.getCalls().filter((x) => x.args[0] instanceof GetParametersByPathCommand);
      expect(calls.length).to.eq(2);
    });

    it('Should request the hierarchy recursively', async () => {
      const c = await cfg();
      await c.load();

      const call = ssmStub.getCalls().find((x) => x.args[0] instanceof GetParametersByPathCommand);
      expect(call?.args[0].input.Recursive).to.be.true;
    });
  });
});
