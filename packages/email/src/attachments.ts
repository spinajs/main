import { IOFail } from '@spinajs/exceptions';
import { fs, getFs } from '@spinajs/fs';
import type { IEmailAttachement } from './interfaces.js';

/**
 * Downloads `a.path` through the attachment's filesystem (`a.provider`, else `defaultProvider`) and returns the local
 * file. It runs in the caller's async context, so a guarded filesystem checks `fs:read` as whoever calls it.
 */
export async function downloadAttachment(a: IEmailAttachement, defaultProvider: string | undefined): Promise<string> {
  const name = a.provider || defaultProvider;

  let provider: fs | undefined;
  try {
    provider = getFs(name);
  } catch (err) {
    throw new IOFail(`Filesystem provider for ${name} not registered. Make sure all required fs providers are imported`, err);
  }

  if (!provider) {
    throw new IOFail(`Filesystem provider for ${name} not registered. Make sure all required fs providers are imported`);
  }

  return provider.download(a.path);
}

/** `a.file` when the email service already read the attachment, else {@link downloadAttachment}. */
export async function attachmentFile(a: IEmailAttachement, defaultProvider: string | undefined): Promise<string> {
  return a.file ?? downloadAttachment(a, defaultProvider);
}
