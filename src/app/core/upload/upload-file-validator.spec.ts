import {
  MAX_UPLOAD_BYTES,
  validateAndReadSingleFile,
} from './upload-file-validator';

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
      text: () => Promise.resolve(''),
    } as unknown as File;
    const result = await validateAndReadSingleFile([oversizedStub]);
    expect(result).toEqual({ kind: 'tooLarge' });
  });

  it('returns ok when the file is exactly at the maximum byte limit', async () => {
    const boundaryContent = 'boundary-content';
    const boundaryStub = {
      size: MAX_UPLOAD_BYTES,
      text: () => Promise.resolve(boundaryContent),
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

  it('returns readFailed with the original cause when text() rejects', async () => {
    const readError = new Error('boom');
    const rejectingStub = {
      size: 10,
      text: () => Promise.reject(readError),
    } as unknown as File;
    const result = await validateAndReadSingleFile([rejectingStub]);
    expect(result).toEqual({ kind: 'readFailed', cause: readError });
  });
});
