import {
  MAX_UPLOAD_BYTES,
  validateAndReadSingleFile,
} from './upload-file-validator';

function utf8Buffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}

describe('validateAndReadSingleFile', () => {
  it('returns empty when no files are provided', async () => {
    const result = await validateAndReadSingleFile([]);
    expect(result).toEqual({ kind: 'empty' });
  });

  it('returns tooMany when more than one file is provided', async () => {
    const firstFile = new File(['{"a":1}'], 'first.json', {
      type: 'application/json',
    });
    const secondFile = new File(['{"b":2}'], 'second.json', {
      type: 'application/json',
    });
    const result = await validateAndReadSingleFile([firstFile, secondFile]);
    expect(result).toEqual({ kind: 'tooMany' });
  });

  it('returns tooLarge when the file exceeds the maximum byte limit', async () => {
    const oversizedStub = {
      size: MAX_UPLOAD_BYTES + 1,
      name: 'oversized.json',
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as File;
    const result = await validateAndReadSingleFile([oversizedStub]);
    expect(result).toEqual({ kind: 'tooLarge' });
  });

  it('returns ok when the file is exactly at the maximum byte limit', async () => {
    const boundaryContent = 'boundary-content';
    const boundaryBuffer = utf8Buffer(boundaryContent);
    const boundaryStub = {
      size: MAX_UPLOAD_BYTES,
      name: 'boundary.json',
      text: () => Promise.resolve(boundaryContent),
      arrayBuffer: () => Promise.resolve(boundaryBuffer),
    } as unknown as File;
    const result = await validateAndReadSingleFile([boundaryStub]);
    expect(result).toEqual({ kind: 'ok', text: boundaryContent });
  });

  it('returns ok with the file text for a single small valid file', async () => {
    const expectedText = '{"a":1}';
    const validFile = new File([expectedText], 'sample.json', {
      type: 'application/json',
    });
    const result = await validateAndReadSingleFile([validFile]);
    expect(result).toEqual({ kind: 'ok', text: expectedText });
  });

  it('returns readFailed with the original cause when arrayBuffer() rejects', async () => {
    const readError = new Error('boom');
    const rejectingStub = {
      size: 10,
      name: 'broken.json',
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.reject(readError),
    } as unknown as File;
    const result = await validateAndReadSingleFile([rejectingStub]);
    expect(result).toEqual({ kind: 'readFailed', cause: readError });
  });

  it('returns binary when the file starts with PNG magic bytes', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const pngFile = new File([pngBytes], 'logo.png', { type: 'image/png' });
    const result = await validateAndReadSingleFile([pngFile]);
    expect(result).toEqual({ kind: 'binary', filename: 'logo.png' });
  });

  it('returns binary for a PDF magic-byte file regardless of MIME type', async () => {
    const pdfFile = new File(['%PDF-1.7\nbody...'], 'document.pdf', {
      type: 'application/octet-stream',
    });
    const result = await validateAndReadSingleFile([pdfFile]);
    expect(result).toEqual({ kind: 'binary', filename: 'document.pdf' });
  });

  it('returns binary for a ZIP/OOXML container (.docx)', async () => {
    const zipBytes = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
    ]);
    const docxFile = new File([zipBytes], 'report.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const result = await validateAndReadSingleFile([docxFile]);
    expect(result).toEqual({ kind: 'binary', filename: 'report.docx' });
  });

  it('returns binary when the decoded text contains a stray NUL', async () => {
    const nulFile = new File(['hello\u0000world'], 'corrupt.json', {
      type: 'application/json',
    });
    const result = await validateAndReadSingleFile([nulFile]);
    expect(result).toEqual({ kind: 'binary', filename: 'corrupt.json' });
  });

  it('passes a text file even when its MIME type is misleadingly application/octet-stream', async () => {
    const textPretendingBinary = new File(['{"a":1}'], 'data.bin', {
      type: 'application/octet-stream',
    });
    const result = await validateAndReadSingleFile([textPretendingBinary]);
    expect(result).toEqual({ kind: 'ok', text: '{"a":1}' });
  });
});
