export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type UploadResult =
  | { kind: 'ok'; text: string }
  | { kind: 'empty' }
  | { kind: 'tooMany' }
  | { kind: 'tooLarge' }
  | { kind: 'readFailed'; cause: unknown };

export async function validateAndReadSingleFile(
  files: readonly File[]
): Promise<UploadResult> {
  if (files.length === 0) return { kind: 'empty' };
  if (files.length > 1) return { kind: 'tooMany' };
  const [file] = files;
  if (file.size > MAX_UPLOAD_BYTES) return { kind: 'tooLarge' };
  try {
    const text = await file.text();
    return { kind: 'ok', text };
  } catch (cause) {
    return { kind: 'readFailed', cause };
  }
}
