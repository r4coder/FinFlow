import { Db } from '../db';

export interface DuplicateKey {
  organizationId: string;
  invoiceId: string;
  createdAt: Date;
  vendorId: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  total: number | null;
  fileHash: string | null;
}

export interface DuplicateResult {
  duplicate: boolean;
  duplicateOfId: string | null;
  reasons: string[];
}

/**
 * Duplicate = same vendor + invoice number + invoice date + total, OR identical document fingerprint (SHA-256).
 * Only EARLIER invoices count, so re-processing the original never flags it as a duplicate of its own copy.
 */
export async function detectDuplicate(db: Db, k: DuplicateKey): Promise<DuplicateResult> {
  const earlier = {
    organizationId: k.organizationId,
    id: { not: k.invoiceId },
    status: { not: 'FAILED' as const },
    OR: [{ createdAt: { lt: k.createdAt } }, { createdAt: k.createdAt, id: { lt: k.invoiceId } }],
  };
  const reasons: string[] = [];
  let duplicateOfId: string | null = null;

  if (k.vendorId && k.invoiceNumber && k.invoiceDate && k.total !== null) {
    const match = await db.invoice.findFirst({
      where: { ...earlier, vendorId: k.vendorId, invoiceNumber: k.invoiceNumber, invoiceDate: k.invoiceDate, total: k.total },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (match) {
      duplicateOfId = match.id;
      reasons.push('Same vendor, invoice number, date and total');
    }
  }
  if (k.fileHash) {
    const match = await db.invoice.findFirst({ where: { ...earlier, fileHash: k.fileHash }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (match) {
      duplicateOfId = duplicateOfId ?? match.id;
      reasons.push('Identical document fingerprint (file hash)');
    }
  }
  return { duplicate: reasons.length > 0, duplicateOfId, reasons };
}
