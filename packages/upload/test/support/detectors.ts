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
