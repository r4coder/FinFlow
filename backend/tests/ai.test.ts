import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/gemini.provider';
import { MockAIProvider } from '../src/ai/mock.provider';
import { AIProviderError } from '../src/ai/types';
import { mockData, pdf } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const geminiResponse = (text: string, ok = true, status = 200) => ({ ok, status, json: async () => (ok ? { candidates: [{ content: { parts: [{ text }] } }] } : { error: { message: 'boom' } }) });
const input = { buffer: Buffer.from('%PDF-1.4 x %%EOF'), mimeType: 'application/pdf', fileName: 'a.pdf' };

describe('MockAIProvider', () => {
  it('is deterministic for the same bytes and differs for different bytes', async () => {
    const p = new MockAIProvider();
    const a = await p.extractInvoice({ ...input, buffer: Buffer.from('aaa') });
    const b = await p.extractInvoice({ ...input, buffer: Buffer.from('aaa') });
    const c = await p.extractInvoice({ ...input, buffer: Buffer.from('bbb') });
    expect(a).toEqual(b);
    expect(a.invoiceNumber).not.toBe(c.invoiceNumber);
    expect(a.subtotal! + a.tax!).toBeCloseTo(a.total!, 2);
  });
  it('honours the MOCKDATA hook', async () => {
    const e = await new MockAIProvider().extractInvoice({ ...input, buffer: pdf(mockData({ total: 777, invoiceNumber: 'X-1' })) });
    expect(e.total).toBe(777);
    expect(e.invoiceNumber).toBe('X-1');
  });
});

describe('GeminiProvider (HTTP mocked; no live Google calls)', () => {
  it('parses structured JSON, sends the key only in a header, and uses inline file data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiResponse(JSON.stringify(mockData({ total: 1234 }))));
    vi.stubGlobal('fetch', fetchMock);
    const out = await new GeminiProvider('SECRET-KEY-ABC', 'gemini-test').extractInvoice(input);
    expect(out.total).toBe(1234);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('SECRET-KEY-ABC');
    expect((init as any).headers['x-goog-api-key']).toBe('SECRET-KEY-ABC');
    const body = JSON.parse((init as any).body);
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe('application/pdf');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });
  it('strips markdown fences and converts UNKNOWN to null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiResponse('```json\n' + JSON.stringify({ invoiceNumber: 'UNKNOWN', total: '10', lineItems: [], confidence: 0.4 }) + '\n```')));
    const out = await new GeminiProvider('k', 'm').extractInvoice(input);
    expect(out.invoiceNumber).toBeNull();
    expect(out.total).toBe(10);
  });
  it('rejects non-JSON output as a retryable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiResponse('Sorry, I cannot read this')));
    await expect(new GeminiProvider('k', 'm').extractInvoice(input)).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/not valid JSON/) });
  });
  it('rejects schema-invalid output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiResponse(JSON.stringify({ lineItems: 'x', confidence: 5 }))));
    await expect(new GeminiProvider('k', 'm').extractInvoice(input)).rejects.toThrow(/schema validation/);
  });
  it('classifies API errors: 429/5xx retryable, 4xx not; network failures retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiResponse('', false, 429)));
    await expect(new GeminiProvider('k', 'm').extractInvoice(input)).rejects.toMatchObject({ retryable: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiResponse('', false, 403)));
    await expect(new GeminiProvider('k', 'm').extractInvoice(input)).rejects.toMatchObject({ retryable: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(new GeminiProvider('k', 'm').extractInvoice(input)).rejects.toBeInstanceOf(AIProviderError);
  });
  it('validateKey reports valid / rejected / unreachable without echoing the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    expect(await GeminiProvider.validateKey('good-key-123')).toEqual({ valid: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    const bad = await GeminiProvider.validateKey('bad-key-123456');
    expect(bad.valid).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('bad-key');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await GeminiProvider.validateKey('x')).valid).toBe(false);
  });
});
