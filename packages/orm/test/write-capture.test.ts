import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { QueryMiddleware } from '../src/interfaces.js';
import { WriteCaptureMiddleware, captureKeyText } from '../src/capture/index.js';
import { countKeyless, keyTexts } from '../src/capture/keys.js';
import { ORM_CONFIGURATION_SCHEMA } from '../src/configuration-schema.js';

const expect = chai.expect;

describe('write capture registration', () => {
  it('is a QueryMiddleware at order 91', () => {
    expect(DI.getRegisteredTypes(QueryMiddleware)).to.include(WriteCaptureMiddleware);
    expect(new WriteCaptureMiddleware().order).to.eq(91);
  });

  it('turns keys into text and refuses what has none', () => {
    expect(captureKeyText('a')).to.eq('a');
    expect(captureKeyText(7)).to.eq('7');
    expect(captureKeyText(2n ** 70n)).to.eq('1180591620717411303424');
    expect(captureKeyText(1.5)).to.eq(undefined);
    expect(captureKeyText(new Date(0))).to.eq(undefined);
  });

  it('keeps the key values with no text apart from the texts', () => {
    const bytes = Buffer.from([1]);
    expect(keyTexts(['a', 7, 'a', bytes, 1.5])).to.deep.eq({ keys: ['a', '7'], keyless: [bytes, 1.5] });
  });

  it('counts a keyless row several reads met once', () => {
    expect(countKeyless([[Buffer.from([1]), Buffer.from([2])], [], [Buffer.from([2]), Buffer.from([3])]])).to.eq(3);
    expect(countKeyless([[new Date(0)], [new Date(0)], [1.5]])).to.eq(2);
  });

  it('declares db.WriteCapture.MaxRows, 0 meaning no limit', () => {
    expect(ORM_CONFIGURATION_SCHEMA.properties.WriteCapture).to.deep.equal({ type: 'object', properties: { MaxRows: { type: 'integer', minimum: 0, default: 0 } } });
  });
});
