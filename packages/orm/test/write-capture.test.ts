import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { QueryMiddleware } from '../src/interfaces.js';
import { WriteCaptureMiddleware, captureKeyText } from '../src/capture/index.js';
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

  it('declares db.WriteCapture.MaxRows, 0 meaning no limit', () => {
    expect(ORM_CONFIGURATION_SCHEMA.properties.WriteCapture).to.deep.equal({ type: 'object', properties: { MaxRows: { type: 'integer', minimum: 0, default: 0 } } });
  });
});
