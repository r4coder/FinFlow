import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { badRequest } from '../utils/errors';

const TYPES: Record<string, { mime: string[]; magic: (b: Buffer) => boolean; complete: (b: Buffer) => boolean }> = {
  '.pdf': {
    mime: ['application/pdf'],
    magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
    complete: (b) => b.subarray(Math.max(0, b.length - 2048)).toString('latin1').includes('%%EOF'),
  },
  '.png': {
    mime: ['image/png'],
    magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    complete: (b) => b.subarray(Math.max(0, b.length - 16)).toString('latin1').includes('IEND'),
  },
  '.jpg': {
    mime: ['image/jpeg'],
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    complete: (b) => b.subarray(Math.max(0, b.length - 2048)).includes(Buffer.from([0xff, 0xd9])),
  },
};
TYPES['.jpeg'] = TYPES['.jpg'];

export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** Validates size, extension, declared MIME type, magic bytes (real content type) and basic file integrity. */
export function validateUpload(file: UploadedFile | undefined, maxBytes: number) {
  if (!file) throw badRequest('No file uploaded (field name must be "file")', 'FILE_MISSING');
  if (file.size === 0) throw badRequest('The file is empty', 'FILE_EMPTY');
  if (file.size > maxBytes) throw badRequest(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`, 'FILE_TOO_LARGE');
  const ext = path.extname(file.originalname).toLowerCase();
  const rule = TYPES[ext];
  if (!rule) throw badRequest(`Unsupported file type "${ext || 'unknown'}". Allowed: PDF, PNG, JPG, JPEG`, 'FILE_TYPE_UNSUPPORTED');
  if (!rule.mime.includes(file.mimetype)) throw badRequest(`MIME type ${file.mimetype} does not match the ${ext} extension`, 'FILE_MIME_MISMATCH');
  if (!rule.magic(file.buffer)) throw badRequest('File content does not match its extension (possible spoofed file)', 'FILE_CONTENT_MISMATCH');
  if (!rule.complete(file.buffer)) throw badRequest('File appears to be truncated or corrupted', 'FILE_CORRUPT');
  const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'invoice';
  return { ext, mime: rule.mime[0], safeName: `${randomUUID().slice(0, 8)}-${base}${ext}`, displayName: path.basename(file.originalname).slice(0, 200) };
}
