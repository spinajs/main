/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DateTime } from 'luxon';

import { DI } from '@spinajs/di';
import { format } from '../src/variables.js';

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
      } as any,
      '${greet:bob}',
    );
    expect(formatted).to.eq('hi bob');
  });

  it('Should call object property when it is a function (${obj:prop})', () => {
    const formatted = format(
      {
        message: 'ignored',
        obj: { stamp: () => 'STAMPED' },
      } as any,
      '${obj:stamp}',
    );
    expect(formatted).to.eq('STAMPED');
  });

  it('Should keep special replacement patterns ($&, $`) literal in values', () => {
    expect(format({ weird: 'a$&b' } as any, '${weird}')).to.eq('a$&b');
    expect(format({ weird: 'x$`y' } as any, '${weird}')).to.eq('x$`y');
    expect(format({ weird: 'price $100 & 50%' } as any, 'cost: ${weird}')).to.eq('cost: price $100 & 50%');
  });

  it('Should replace every occurrence of a string custom var', () => {
    expect(format({ x: 'Q' } as any, '${x}-${x}-${x}')).to.eq('Q-Q-Q');
  });

  it('Should recursively format the message field before interpolation', () => {
    const formatted = format(
      {
        message: 'hello ${who}',
        who: 'world',
      } as any,
      '[${message}]',
    );
    expect(formatted).to.eq('[hello world]');
  });

  it('Should format against DI variables when custom vars are null', () => {
    expect(format(null, '${date}')).to.eq(DateTime.now().toFormat('dd/MM/yyyy'));
  });
});
