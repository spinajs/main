import { expect } from 'chai';
import 'mocha';
import { AsyncService, Autoinject, Injectable } from '@spinajs/di';

import { CONFIG_FILE_DEFAULT_MAX_SIZE, ConfigFileValidator, ConfigurationEntryType, IConfigurationEntryMeta, normalizeFileEntryOptions, resolveConfigFileValidator } from './../src/index.js';

@Injectable(ConfigFileValidator)
class ClassNamedTemplateValidator extends ConfigFileValidator {
  public validate(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable(ConfigFileValidator)
class ServiceNamedTemplateValidator extends ConfigFileValidator {
  public ServiceName = 'custom-template-check';

  public validate(): Promise<void> {
    return Promise.resolve();
  }
}

class SlowTemplateDependency extends AsyncService {}

@Injectable(ConfigFileValidator)
class AsyncResolvedTemplateValidator extends ConfigFileValidator {
  public ServiceName = 'async-template-check';

  @Autoinject()
  protected Dependency!: SlowTemplateDependency;

  public validate(): Promise<void> {
    return Promise.resolve();
  }
}

type ExposeOptions = { type: ConfigurationEntryType; meta?: IConfigurationEntryMeta };

describe('configuration file entry options', () => {
  it('defaults the max upload size to 10 MB', () => {
    expect(CONFIG_FILE_DEFAULT_MAX_SIZE).to.equal(10 * 1024 * 1024);
  });

  it('replaces a class validator with its class name', () => {
    const options: ExposeOptions = { type: 'file', meta: { file: { fs: 'fs-templates', validator: ClassNamedTemplateValidator } } };

    normalizeFileEntryOptions('tpl.offer', options);

    expect(options.meta?.file?.validator).to.equal('ClassNamedTemplateValidator');
  });

  it('keeps a validator given by name', () => {
    const options: ExposeOptions = { type: 'file', meta: { file: { fs: 'fs-templates', validator: 'custom-template-check' } } };

    normalizeFileEntryOptions('tpl.offer', options);

    expect(options.meta?.file?.validator).to.equal('custom-template-check');
  });

  it('throws naming the slug for a file entry without meta.file.fs', () => {
    expect(() => normalizeFileEntryOptions('tpl.missing', { type: 'file' })).to.throw(/tpl\.missing/);
    expect(() => normalizeFileEntryOptions('tpl.missing', { type: 'file', meta: { file: { fs: '' } } })).to.throw(/tpl\.missing/);
  });

  it('accepts entries of other types without file options', () => {
    expect(() => normalizeFileEntryOptions('app.name', { type: 'string' })).to.not.throw();
    expect(() => normalizeFileEntryOptions('app.name', undefined)).to.not.throw();
  });

  it('resolves a registered validator by class name', async () => {
    expect(await resolveConfigFileValidator('ClassNamedTemplateValidator')).to.be.instanceOf(ClassNamedTemplateValidator);
  });

  it('resolves a registered validator by ServiceName', async () => {
    expect(await resolveConfigFileValidator('custom-template-check')).to.be.instanceOf(ServiceNamedTemplateValidator);
  });

  it('resolves a validator whose dependencies resolve asynchronously', async () => {
    const validator = await resolveConfigFileValidator('async-template-check');

    expect(validator).to.be.instanceOf(AsyncResolvedTemplateValidator);
    expect(validator?.validate).to.be.a('function');
  });

  it('returns undefined for an unknown validator name', async () => {
    expect(await resolveConfigFileValidator('NoSuchTemplateValidator')).to.equal(undefined);
  });
});
