import { detectBinary } from './binary-detection';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type UploadResult =
  | { kind: 'ok'; text: string }
  | { kind: 'empty' }
  | { kind: 'tooMany' }
  | { kind: 'tooLarge'; sizeBytes: number }
  | { kind: 'binary'; filename: string }
  | { kind: 'readFailed'; cause: unknown };

export async function validateAndReadSingleFile(
  files: readonly File[]
): Promise<UploadResult> {
  if (files.length === 0) return { kind: 'empty' };
  if (files.length > 1) return { kind: 'tooMany' };
  const [file] = files;
  if (file.size > MAX_UPLOAD_BYTES) return { kind: 'tooLarge', sizeBytes: file.size };
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (cause) {
    return { kind: 'readFailed', cause };
  }
  const detection = detectBinary(new Uint8Array(buffer));
  if (detection.isBinary) {
    return { kind: 'binary', filename: file.name };
  }
  return { kind: 'ok', text: detection.text };
}
