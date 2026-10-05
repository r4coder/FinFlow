import { z } from 'zod';
import { AIProvider, AIProviderError, AnalysisInput, AnalysisOutput, ExtractedInvoice, ExtractedInvoiceSchema, ExtractInput } from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const EXTRACTION_PROMPT = `You are an accounts-payable document extraction engine.
Extract the invoice in the attached document into the JSON schema provided.
Rules:
- Return ONLY values that are explicitly present in the document. NEVER guess or invent values.
- If a value cannot be determined, use null.
- Dates must be formatted YYYY-MM-DD. Monetary values are plain numbers without currency symbols or thousand separators.
- currency is the ISO 4217 code (e.g. INR, USD) if it can be determined, otherwise null.
- lineTotal is quantity x unitPrice BEFORE tax. taxRate is a percentage (18 means 18%).
- confidence is your overall confidence (0 to 1) that the extraction is correct and complete.`;

const responseSchema = {
  type: 'OBJECT',
  properties: {
    invoiceNumber: { type: 'STRING', nullable: true },
    vendorName: { type: 'STRING', nullable: true },
    vendorTaxId: { type: 'STRING', nullable: true },
    invoiceDate: { type: 'STRING', nullable: true },
    dueDate: { type: 'STRING', nullable: true },
    currency: { type: 'STRING', nullable: true },
    subtotal: { type: 'NUMBER', nullable: true },
    tax: { type: 'NUMBER', nullable: true },
    total: { type: 'NUMBER', nullable: true },
    purchaseOrderNumber: { type: 'STRING', nullable: true },
    paymentTerms: { type: 'STRING', nullable: true },
    lineItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          quantity: { type: 'NUMBER' },
          unitPrice: { type: 'NUMBER' },
          taxRate: { type: 'NUMBER', nullable: true },
          taxAmount: { type: 'NUMBER', nullable: true },
          lineTotal: { type: 'NUMBER', nullable: true },
        },
        required: ['description', 'quantity', 'unitPrice'],
      },
    },
    confidence: { type: 'NUMBER' },
  },
  required: ['lineItems', 'confidence'],
};

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini' as const;

  constructor(
    private apiKey: string,
    readonly model: string,
  ) {}

  /** The API key is only ever sent in a request header, never in the URL, so it cannot leak via logs. */
  private async generate(parts: unknown[], generationConfig: Record<string, unknown>): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, ...generationConfig } }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      throw new AIProviderError(`Gemini request failed: ${(e as Error).message}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new AIProviderError(`Gemini API error (${res.status}): ${body.error?.message ?? 'unknown'}`, retryable);
    }
    if (body.promptFeedback?.blockReason) throw new AIProviderError(`Gemini blocked the request: ${body.promptFeedback.blockReason}`, false);
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new AIProviderError('Gemini returned an empty response', true);
    return text;
  }

  static parseJson(text: string): unknown {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  }

  async extractInvoice(input: ExtractInput): Promise<ExtractedInvoice> {
    const text = await this.generate(
      [{ text: EXTRACTION_PROMPT }, { inline_data: { mime_type: input.mimeType, data: input.buffer.toString('base64') } }],
      { responseMimeType: 'application/json', responseSchema },
    );
    let json: unknown;
    try {
      json = GeminiProvider.parseJson(text);
    } catch {
      throw new AIProviderError('Gemini returned output that is not valid JSON', true);
    }
    const parsed = ExtractedInvoiceSchema.safeParse(json);
    if (!parsed.success) {
      throw new AIProviderError(`Gemini output failed schema validation: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`, true);
    }
    return parsed.data;
  }

  async analyzeInvoice(input: AnalysisInput): Promise<AnalysisOutput> {
    const prompt = `You are an accounts-payable risk analyst. Based ONLY on the deterministic findings below, write a concise (max 2 sentences) plain-English explanation for a finance reviewer, and an aiScore from 0 (no concern) to 100 (severe concern). Do not recommend approving or rejecting; company business rules decide that.
Respond as JSON: {"explanation": string, "aiScore": number}.
Risk level: ${input.riskLevel}
Findings: ${JSON.stringify(input.findings)}
Extracted data: ${JSON.stringify({ ...input.extraction, lineItems: input.extraction.lineItems.length })}`;
    const text = await this.generate([{ text: prompt }], { responseMimeType: 'application/json' });
    const parsed = z.object({ explanation: z.string(), aiScore: z.coerce.number().min(0).max(100) }).safeParse(GeminiProvider.parseJson(text));
    if (!parsed.success) throw new AIProviderError('Gemini analysis output was invalid', true);
    return parsed.data;
  }

  async generateInsight(stats: Record<string, unknown>): Promise<string> {
    return this.generate([{ text: `Write a 2-sentence insight for a finance team about these invoice stats: ${JSON.stringify(stats)}` }], {});
  }

  /** Cheap authenticated call used by "Validate Key". Returns a safe, secret-free result. */
  static async validateKey(apiKey: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      const res = await fetch(`${BASE}/models?pageSize=1`, {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 400 || res.status === 401 || res.status === 403) return { valid: false, reason: 'The API key was rejected by Google' };
      return { valid: false, reason: `Unexpected response from Google (${res.status})` };
    } catch {
      return { valid: false, reason: 'Could not reach the Gemini API' };
    }
  }
}
