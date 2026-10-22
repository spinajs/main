/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DateTime } from 'luxon';

import { DI, Injectable } from '@spinajs/di';
import { ConfigVariable, format } from '../src/variables.js';

// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
chai.use(chaiAsPromised);

describe('Variable forma test', () => {
  beforeEach(() => {
    DI.clearCache();
  });

  it('Should format with basic variables', () => {
    const formatted = format(
      {
        message: 'hello world',
      },
      '${date} ${message}',
    );

    expect(formatted).to.eq(`${DateTime.now().toFormat('dd/MM/yyyy')} hello world`);
  });

  it('Should render conditional block when variable exists', () => {
    const formatted = format(
      {
        message: 'Connection failed',
        error: { message: 'Network timeout' },
      },
      '${message}${?error} Exception: ${error:message}${/error}',
    );

    expect(formatted).to.eq('Connection failed Exception: Network timeout');
  });

  it('Should not render conditional block when variable is undefined', () => {
    const formatted = format(
      {
        message: 'Server started',
      },
      '${message}${?error} Exception: ${error:message}${/error}',
    );

    expect(formatted).to.eq('Server started');
  });

  it('Should not render conditional block when variable is null', () => {
    const formatted = format(
      {
        message: 'Operation complete',
        error: null,
      },
      '${message}${?error} Exception: ${error:message}${/error}',
    );

    expect(formatted).to.eq('Operation complete');
  });

  it('Should not render conditional block when variable is empty string', () => {
    const formatted = format(
      {
        message: 'Request processed',
        error: '',
      },
      '${message}${?error} Exception: ${error:message}${/error}',
    );

    expect(formatted).to.eq('Request processed');
  });

  it('Should handle multiple conditional blocks', () => {
    const formatted = format(
      {
        message: 'Request processed',
        user: 'john',
        error: { message: 'Failed' },
      },
      '${message}${?user} User: ${user}${/user}${?error} Error: ${error:message}${/error}',
    );

    expect(formatted).to.eq('Request processed User: john Error: Failed');
  });

  it('Should handle nested variables inside conditionals', () => {
    const formatted = format(
      {
        level: 'ERROR',
        message: 'Database error',
        error: { message: 'Connection refused', code: 500 },
      },
      '${level} ${message}${?error} [${error:code}] ${error:message}${/error}',
    );

    expect(formatted).to.eq('ERROR Database error [500] Connection refused');
  });

  it('Should work with conditional and regular variables mixed', () => {
    const formatted = format(
      {
        message: 'Log entry',
        logger: 'app',
      },
      '${date} ${message}${?error} Exception: ${error:message}${/error} (${logger})',
    );

    expect(formatted).to.eq(`${DateTime.now().toFormat('dd/MM/yyyy')} Log entry (app)`);
  });

  it('Should resolve DI-registered variable (env) when not in custom vars', () => {
    process.env.SPINAJS_FORMAT_TEST = 'from-env';
    try {
      expect(format(null, 'value: ${env:SPINAJS_FORMAT_TEST}')).to.eq('value: from-env');
    } finally {
      delete process.env.SPINAJS_FORMAT_TEST;
    }
  });

  it('Should replace unknown variable with empty string', () => {
    expect(format({ message: 'x' }, 'a ${doesnotexist} b')).to.eq('a  b');
  });

  it('Should call a function custom var with its option as argument', () => {
    const formatted = format(
      {
        message: 'ignored',
        greet: (name?: string) => `hi ${name ?? 'anon'}`,
      },
      '${greet:bob}',
    );
    expect(formatted).to.eq('hi bob');
  });

  it('Should call object property when it is a function (${obj:prop})', () => {
    const formatted = format(
      {
        message: 'ignored',
        obj: { stamp: () => 'STAMPED' },
      },
      '${obj:stamp}',
    );
    expect(formatted).to.eq('STAMPED');
  });

  it('Should keep special replacement patterns ($&, $`) literal in values', () => {
    expect(format({ weird: 'a$&b' }, '${weird}')).to.eq('a$&b');
    expect(format({ weird: 'x$`y' }, '${weird}')).to.eq('x$`y');
    expect(format({ weird: 'price $100 & 50%' }, 'cost: ${weird}')).to.eq('cost: price $100 & 50%');
  });

  it('Should replace every occurrence of a string custom var', () => {
    expect(format({ x: 'Q' }, '${x}-${x}-${x}')).to.eq('Q-Q-Q');
  });

  it('Should recursively format the message field before interpolation', () => {
    const formatted = format(
      {
        message: 'hello ${who}',
        who: 'world',
      },
      '[${message}]',
    );
    expect(formatted).to.eq('[hello world]');
  });

  it('Should render 0 and empty string custom values instead of falling through', () => {
    expect(format({ count: 0 }, '[${count}]')).to.eq('[0]');
    expect(format({ user: '' }, '[${user}]')).to.eq('[]');
  });

  it('Should not render conditional block when variable is false', () => {
    expect(format({ flag: false }, 'a${?flag} on${/flag}')).to.eq('a');
  });

  it('Should keep replacement patterns literal in function and property values', () => {
    expect(format({ err: { message: 'a$&b' } }, '${err:message}')).to.eq('a$&b');
    expect(format({ fn: () => 'x$`y' }, '${fn}')).to.eq('x$`y');
  });

  it('Should see a variable registered after the first format call', () => {
    expect(format(null, '[${latevar}]')).to.eq('[]');

    @Injectable(ConfigVariable)
    class LateRegisteredVariable extends ConfigVariable {
      public get Name(): string {
        return 'latevar';
      }
      public Value(): string {
        return 'late';
      }
    }

    try {
      expect(format(null, '[${latevar}]')).to.eq('[late]');
    } finally {
      DI.unregister(LateRegisteredVariable);
    }
  });

  it('Should format against DI variables when custom vars are null', () => {
    expect(format(null, '${date}')).to.eq(DateTime.now().toFormat('dd/MM/yyyy'));
  });

  it('Should close a conditional block at the first matching close tag only', () => {
    const vars = { a: 1, b: 1 } as any;
    expect(format(vars, '${?a}1${/a}2${/a}')).to.eq('12');
    expect(format(vars, '${?a}${?a}x${/a}')).to.eq('x');
    expect(format(vars, '<${?a}x${?b}y${/a}z${/b}>')).to.eq('<xyz>');
    expect(format({ b: 1 }, '${?a}x${/b}${?b}y${/b}${/a}')).to.eq('');
    expect(format({ a: 1 }, '${?b}x${/a}${?a}y${/b}${/a}')).to.eq('');
    expect(format(vars, '${?a}open ${?b}done${/b}')).to.eq('open done');
  });

  it('Should format text with unclosed tags in linear time', () => {
    const started = performance.now();
    expect(format({ message: '${?0}' + '${?0}a'.repeat(20_000) }, '${message}')).to.eq('a'.repeat(20_000));
    expect(format({ message: '${'.repeat(50_000) }, '[${message}]')).to.eq('[' + '${'.repeat(50_000) + ']');
    expect(format(null, '${?a}'.repeat(50_000) + '${/b}')).to.eq('');
    expect(performance.now() - started).to.be.below(1000);
  });
});
