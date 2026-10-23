import { Config } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import mime from 'mime-types';
import type { Detector } from 'file-type';

import { loadFileType } from '../file-type.js';
import type { AllowedTypes, UploadConfig } from '../types.js';
import { ContentDetector } from './detector.js';

/** The detector id reported when file-type's built-in detectors matched. */
export const FILE_TYPE_DETECTOR_ID = 'file-type';

export const allowsType = (types: AllowedTypes, type: string): boolean => types === '*' || types.includes(type);

export interface ContentCheckInput {
  readonly head: Uint8Array;
  readonly declaredMime: string | null;
  readonly allowedTypes: AllowedTypes;
}

export type ContentRefusal = 'upload.content_mismatch' | 'upload.unsupported_type';

interface ContentFound {
  readonly detectedMime: string | null;
  readonly detectorId: string | null;
}

export type ContentCheckResult = (ContentFound & { readonly accepted: true }) | (ContentFound & { readonly accepted: false; readonly code: ContentRefusal });

/** mime-types maps the client's file name, file-type reads the magic bytes (spec D3, §4.3). */
@Singleton()
@Injectable()
export class ContentTypeCheck {
  @Config('upload.detect')
  protected Options: UploadConfig['detect'];

  @Logger('upload')
  protected Log: Log;

  public mimeOf(name: string): string | null {
    const found = mime.lookup(name);
    return found === false ? null : found;
  }

  public async detect(head: Uint8Array): Promise<{ mime: string; detectorId: string } | null> {
    const match = { id: null as string | null };
    const { FileTypeParser } = await loadFileType();
    const result = await new FileTypeParser({ customDetectors: this.adapters(head, match) }).fromBuffer(head);
    return result ? { mime: result.mime, detectorId: match.id ?? FILE_TYPE_DETECTOR_ID } : null;
  }

  public async check(input: ContentCheckInput): Promise<ContentCheckResult> {
    const detected = await this.detect(input.head);
    const found: ContentFound = { detectedMime: detected?.mime ?? null, detectorId: detected?.detectorId ?? null };
    const refusal = this.refusalOf(input, found.detectedMime);
    return refusal === null ? { ...found, accepted: true } : { ...found, accepted: false, code: refusal };
  }

  private refusalOf(input: ContentCheckInput, detected: string | null): ContentRefusal | null {
    if (detected === null && (input.declaredMime === null || !this.Options.allowUndetected.includes(input.declaredMime))) return 'upload.content_mismatch';
    if (detected !== null && input.declaredMime !== null && detected !== input.declaredMime) return 'upload.content_mismatch';
    const effective = detected ?? input.declaredMime;
    return effective !== null && allowsType(input.allowedTypes, effective) ? null : 'upload.unsupported_type';
  }

  /** The app's detectors read the captured head, never the tokenizer, so file-type goes on after a null (file-type/core.d.ts:142-147). */
  private adapters(head: Uint8Array, match: { id: string | null }): Detector[] {
    const registered = (DI.resolve(Array.ofType(ContentDetector)) as unknown as ContentDetector[] | undefined) ?? [];
    return registered
      .filter((d) => d instanceof ContentDetector)
      .map((d) => ({
        id: d.id,
        detect: async () => {
          try {
            const found = await d.detect(head);
            if (!found) return undefined;
            match.id = d.id;
            return found;
          } catch (err) {
            this.Log.warn({ detectorId: d.id, error: err }, 'Content detector ${detectorId} failed; treated as no match');
            return undefined;
          }
        },
      }));
  }
}
