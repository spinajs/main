import { Injectable } from '@spinajs/di';

import { ContentDetector } from '../../src/index.js';
import type { DetectedContent } from '../../src/index.js';

/** DXF the way an app ships it: file-type has no DXF detector (spec §4.3). */
@Injectable(ContentDetector)
export class TestDxfDetector extends ContentDetector {
  public readonly id = 'test-dxf';

  public async detect(head: Uint8Array): Promise<DetectedContent | null> {
    return Buffer.from(head).toString('latin1').startsWith('0\r\nSECTION') ? { ext: 'dxf', mime: 'image/vnd.dxf' } : null;
  }
}

/** A PDF whose header follows some leading bytes; file-type matches %PDF only at byte 0 (spec §4.3). */
@Injectable(ContentDetector)
export class TestLatePdfDetector extends ContentDetector {
  public readonly id = 'test-late-pdf';

  public async detect(head: Uint8Array): Promise<DetectedContent | null> {
    const at = Buffer.from(head).indexOf('%PDF');
    return at > 0 ? { ext: 'pdf', mime: 'application/pdf' } : null;
  }
}

/** Claims a PNG head marked with a trailing OVERRIDE under a custom type; only reachable when app detectors run before file-type's. */
@Injectable(ContentDetector)
export class TestPngOverrideDetector extends ContentDetector {
  public readonly id = 'test-png-override';

  public async detect(head: Uint8Array): Promise<DetectedContent | null> {
    return Buffer.from(head).toString('latin1').endsWith('OVERRIDE') ? { ext: 'png', mime: 'image/x-test-png' } : null;
  }
}

@Injectable(ContentDetector)
export class TestExplodingDetector extends ContentDetector {
  public readonly id = 'test-exploding';

  public async detect(head: Uint8Array): Promise<DetectedContent | null> {
    if (Buffer.from(head).toString('latin1').startsWith('BOOM')) throw new Error('detector down');
    return null;
  }
}

// Fixtures probed against file-type 20.5.0 (see "Facts").
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const PDF = Buffer.from('%PDF-1.7\n');
export const DWG = Buffer.from('AC1015xxxxxxxxxxxxxxxxx');
export const DXF = Buffer.from('0\r\nSECTION\r\n2\r\nHEADER\r\n');
export const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
export const AVI = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST'), Buffer.alloc(8)]);
export const EPS = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n');
export const CFB = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(24)]);
/** A zip local header cut mid-entry: file-type throws EndOfStreamError on it. */
export const TRUNCATED_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]);
export const PNG_OVERRIDE = Buffer.concat([PNG, Buffer.from('OVERRIDE')]);
