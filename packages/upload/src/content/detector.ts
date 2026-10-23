export interface DetectedContent {
  ext: string;
  mime: string;
}

/**
 * Spec §6.4. Apps register one with `@Injectable(ContentDetector)` for formats file-type does not know (DXF, a PDF with
 * leading bytes). The package ships none.
 */
export abstract class ContentDetector {
  public abstract readonly id: string;

  /** Sees the first upload.detect.headBytes bytes; returns null when the content is not this detector's. */
  public abstract detect(head: Uint8Array): Promise<DetectedContent | null>;
}
