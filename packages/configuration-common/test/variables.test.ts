/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { hostname, userInfo, platform as osPlatform, arch as osArch, tmpdir, homedir } from 'os';

import {
  DateTimeLogVariable,
  DateLogVariable,
  TimeLogVariable,
  EnvVariable,
  PathVariable,
  HostnameVariable,
  UserVariable,
  PlatformVariable,
  ArchVariable,
  CwdVariable,
  PidVariable,
  UuidVariable,
  TimestampVariable,
  UtcDateTimeLogVariable,
  UtcDateLogVariable,
  UtcTimeLogVariable,
} from '../src/variables.js';

describe('Config variables', () => {
  describe('temporal', () => {
    it('datetime should use default format and custom option', () => {
      const v = new DateTimeLogVariable();
      expect(v.Name).to.eq('datetime');
      expect(v.Value('yyyy')).to.eq(DateTime.now().toFormat('yyyy'));
      // default format produces a non-empty string of expected shape
      expect(v.Value()).to.match(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\.\d{3}/);
    });

    it('date should use default format and custom option', () => {
      const v = new DateLogVariable();
      expect(v.Name).to.eq('date');
      expect(v.Value()).to.eq(DateTime.now().toFormat('dd/MM/yyyy'));
      expect(v.Value('yyyy-MM-dd')).to.eq(DateTime.now().toFormat('yyyy-MM-dd'));
    });

    it('time should use default format and custom option', () => {
      const v = new TimeLogVariable();
      expect(v.Name).to.eq('time');
      expect(v.Value('HH')).to.eq(DateTime.now().toFormat('HH'));
    });

    it('utcdatetime/utcdate/utctime should format in UTC', () => {
      expect(new UtcDateTimeLogVariable().Name).to.eq('utcdatetime');
      expect(new UtcDateLogVariable().Name).to.eq('utcdate');
      expect(new UtcTimeLogVariable().Name).to.eq('utctime');

      expect(new UtcDateLogVariable().Value('yyyy-MM-dd')).to.eq(DateTime.utc().toFormat('yyyy-MM-dd'));
      expect(new UtcTimeLogVariable().Value('HH')).to.eq(DateTime.utc().toFormat('HH'));
    });

    it('timestamp should return millis by default and seconds with :s', () => {
      const v = new TimestampVariable();
      expect(v.Name).to.eq('timestamp');

      const before = DateTime.now().toMillis();
      const ms = Number(v.Value());
      const after = DateTime.now().toMillis();
      expect(ms).to.be.gte(before).and.lte(after);

      const seconds = Number(v.Value('s'));
      expect(seconds).to.be.closeTo(Math.floor(after / 1000), 2);
      // seconds value is ~1000x smaller than millis
      expect(String(seconds).length).to.be.lessThan(String(ms).length);
    });
  });

  describe('env', () => {
    it('should read an existing env var and return empty for missing', () => {
      const v = new EnvVariable();
      expect(v.Name).to.eq('env');

      process.env.SPINAJS_TEST_VAR = 'hello-env';
      try {
        expect(v.Value('SPINAJS_TEST_VAR')).to.eq('hello-env');
      } finally {
        delete process.env.SPINAJS_TEST_VAR;
      }

      expect(v.Value('SPINAJS_DEFINITELY_MISSING_VAR')).to.eq('');
    });
  });

  describe('system info', () => {
    it('hostname', () => {
      const v = new HostnameVariable();
      expect(v.Name).to.eq('hostname');
      expect(v.Value()).to.eq(hostname());
    });

    it('user', () => {
      const v = new UserVariable();
      expect(v.Name).to.eq('user');
      expect(v.Value()).to.eq(userInfo().username);
    });

    it('platform', () => {
      const v = new PlatformVariable();
      expect(v.Name).to.eq('platform');
      expect(v.Value()).to.eq(osPlatform());
    });

    it('arch', () => {
      const v = new ArchVariable();
      expect(v.Name).to.eq('arch');
      expect(v.Value()).to.eq(osArch());
    });

    it('cwd', () => {
      const v = new CwdVariable();
      expect(v.Name).to.eq('cwd');
      expect(v.Value()).to.eq(process.cwd());
    });

    it('pid', () => {
      const v = new PidVariable();
      expect(v.Name).to.eq('pid');
      expect(v.Value()).to.eq(String(process.pid));
    });
  });

  describe('uuid', () => {
    it('should generate a valid v4 uuid and be unique per call', () => {
      const v = new UuidVariable();
      expect(v.Name).to.eq('uuid');

      const a = v.Value();
      const b = v.Value();
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(a).to.match(uuidRe);
      expect(b).to.match(uuidRe);
      expect(a).to.not.eq(b);
    });
  });

  describe('path', () => {
    const v = new PathVariable();

    it('should have name "path"', () => {
      expect(v.Name).to.eq('path');
    });

    it('temp/home/cwd resolve to os equivalents', () => {
      expect(v.Value('temp')).to.eq(tmpdir());
      expect(v.Value('home')).to.eq(homedir());
      expect(v.Value('cwd')).to.eq(process.cwd());
    });

    it('config/data/cache return non-empty cross-platform dirs', () => {
      expect(v.Value('config')).to.be.a('string').and.not.be.empty;
      expect(v.Value('data')).to.be.a('string').and.not.be.empty;
      expect(v.Value('cache')).to.be.a('string').and.not.be.empty;
    });

    it('appdata is a cross-platform alias of config', () => {
      expect(v.Value('appdata')).to.eq(v.Value('config'));
    });

    it('unknown option returns empty string', () => {
      expect(v.Value('nope')).to.eq('');
      expect(v.Value()).to.eq('');
    });
  });
});
