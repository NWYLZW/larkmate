import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { FeishuError } from './errors.js';

const CHUNK = 4 * 1024 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function uploadFile(gateway, path, { image = false } = {}) {
  let handle;
  try { handle = await open(path, 'r'); }
  catch { throw new FeishuError('FILE_UNAVAILABLE', 'Cannot open the file.'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > (image ? 10 * 1024 * 1024 : MAX_BYTES)) {
      throw new FeishuError('FILE_INVALID', image ? 'Use a regular, non-empty image up to 10 MiB.' : 'Use a regular, non-empty file up to 100 MiB.');
    }
    let mime;
    if (image) {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const b = header.subarray(0, bytesRead);
      if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
      else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) mime = 'image/jpeg';
      else if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) mime = 'image/gif';
      else if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
      else throw new FeishuError('FILE_INVALID', 'Image must be PNG, JPEG, GIF or WebP.');
    }
    const fileType = image ? 2 : 1;
    const name = basename(path);
    await gateway.authenticate();
    const created = gateway.decode('CreateFileUploadResponse', await gateway.uploadRequest('/upload/create',
      gateway.encode('CreateFileUploadRequest', { fileType, fileName: name, fileSize: stat.size }), 'application/x-protobuf'));
    const key = created.uploadId;
    if (typeof key !== 'string' || !/^[\w.-]{1,200}$/.test(key)) {
      throw new FeishuError('UPLOAD_FAILED', 'File upload could not be initialized.');
    }
    const checksums = {};
    let offset = 0;
    let partId = 0;
    while (offset < stat.size) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, stat.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new FeishuError('FILE_CHANGED', 'File changed during upload.');
      partId++;
      const expected = crc32(buffer);
      const part = gateway.decode('UploadFilePartResponse', await gateway.uploadRequest(
        `/upload/part?upload_id=${encodeURIComponent(key)}&part_id=${partId}`, buffer, 'application/octet-stream'));
      if (!Object.hasOwn(part, 'partId') || !Object.hasOwn(part, 'crc32') || part.partId !== partId || part.crc32 !== expected) {
        throw new FeishuError('UPLOAD_FAILED', 'File part checksum did not match.');
      }
      checksums[partId] = expected;
      offset += bytesRead;
    }
    const finalStat = await handle.stat();
    if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) {
      throw new FeishuError('FILE_CHANGED', 'File changed during upload.');
    }
    const completed = gateway.decode('CompleteFileUploadResponse', await gateway.uploadRequest('/upload/complete',
      gateway.encode('CompleteFileUploadRequest', { uploadId: key, fileType, partToCrc32: checksums, fileName: name, ...(mime ? { mime } : {}) }),
      'application/x-protobuf'));
    if (completed.code !== 0) throw new FeishuError('UPLOAD_FAILED', 'File upload completion was rejected.');
    const finalKey = completed.fileKey || (image ? null : key);
    if (typeof finalKey !== 'string' || !/^[\w.-]{1,200}$/.test(finalKey)) throw new FeishuError('UPLOAD_FAILED', 'File upload did not return a usable file key.');
    return { key: finalKey, name, size: stat.size, ...(mime ? { mime } : {}) };
  } finally { await handle.close(); }
}
