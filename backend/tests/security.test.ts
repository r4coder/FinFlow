import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maskSecret } from '../src/security/crypto';
import { redact } from '../src/services/audit.service';
import { validateUpload } from '../src/invoices/file.validation';

describe('credential encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const enc = encryptSecret('AIzaSyEXAMPLE-secret-key-1234');
    expect(JSON.stringify(enc)).not.toContain('AIzaSy');
    expect(decryptSecret(enc)).toBe('AIzaSyEXAMPLE-secret-key-1234');
  });
  it('uses a random IV and detects tampering', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    const tampered = { ...a, ciphertext: Buffer.from('x'.repeat(8)).toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });
  it('masks to the last four characters only', () => {
    expect(maskSecret('1234')).toMatch(/^•+1234$/);
    expect(maskSecret(null)).toBeNull();
  });
  it('audit redaction removes secrets recursively', () => {
    const out = redact({ ok: 1, apiKey: 'abc', nested: { password: 'p', token: 't', fine: 'y' } }) as any;
    expect(out.apiKey).toBe('[redacted]');
    expect(out.nested.password).toBe('[redacted]');
    expect(out.nested.fine).toBe('y');
  });
});

describe('upload validation', () => {
  const pdf = Buffer.from('%PDF-1.4\nbody\n%%EOF\n');
  const f = (o: object = {}) => ({ originalname: 'a.pdf', mimetype: 'application/pdf', buffer: pdf, size: pdf.length, ...o });
  it('accepts a valid PDF and sanitizes the stored name', () => {
    const v = validateUpload(f({ originalname: '../../etc/pa ss?.pdf' }), 1e6);
    expect(v.safeName).toMatch(/^[a-z0-9-]+-[A-Za-z0-9._-]+\.pdf$/);
    expect(v.safeName).not.toContain('/');
  });
  it('rejects wrong extension, MIME mismatch, spoofed content, truncation, oversize, empty', () => {
    expect(() => validateUpload(f({ originalname: 'a.exe' }), 1e6)).toThrow(/Unsupported/);
    expect(() => validateUpload(f({ mimetype: 'image/png' }), 1e6)).toThrow(/MIME/);
    expect(() => validateUpload(f({ buffer: Buffer.from('MZ not a pdf'), size: 12 }), 1e6)).toThrow(/does not match/);
    expect(() => validateUpload(f({ buffer: Buffer.from('%PDF-1.4 cut off'), size: 16 }), 1e6)).toThrow(/truncated/);
    expect(() => validateUpload(f(), 5)).toThrow(/limit/);
    expect(() => validateUpload(f({ size: 0 }), 1e6)).toThrow(/empty/);
    expect(() => validateUpload(undefined, 1e6)).toThrow(/No file/);
  });
  it('accepts PNG and JPEG with correct signatures', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20), Buffer.from('IEND\xaeB`\x82', 'latin1')]);
    expect(validateUpload({ originalname: 'a.png', mimetype: 'image/png', buffer: png, size: png.length }, 1e6).mime).toBe('image/png');
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20), Buffer.from([0xff, 0xd9])]);
    expect(validateUpload({ originalname: 'a.jpeg', mimetype: 'image/jpeg', buffer: jpg, size: jpg.length }, 1e6).mime).toBe('image/jpeg');
  });
});
