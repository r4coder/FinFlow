import { num } from '../utils/money';

export function presentInvoice(inv: any) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    vendorId: inv.vendorId,
    vendor: inv.vendor ? { id: inv.vendor.id, name: inv.vendor.name, verified: inv.vendor.verified, industry: inv.vendor.industry, taxId: inv.vendor.taxId } : null,
    invoiceDate: inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : null,
    dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : null,
    currency: inv.currency,
    subtotal: num(inv.subtotal),
    tax: num(inv.tax),
    total: num(inv.total),
    purchaseOrderNumber: inv.purchaseOrderNumber,
    paymentTerms: inv.paymentTerms,
    status: inv.status,
    processingStatus: inv.processingStatus,
    riskLevel: inv.riskLevel,
    riskScore: inv.riskScore,
    source: inv.source,
    fileName: inv.fileName,
    mimeType: inv.mimeType,
    hasFile: Boolean(inv.fileUrl),
    uploadedBy: inv.uploadedBy,
    approvedBy: inv.approvedBy,
    approvedAt: inv.approvedAt,
    rejectedBy: inv.rejectedBy,
    rejectedAt: inv.rejectedAt,
    rejectionReason: inv.rejectionReason,
    aiConfidence: inv.aiConfidence,
    duplicateDetected: inv.duplicateDetected,
    duplicateOfId: inv.duplicateOfId,
    autoApproved: inv.autoApproved,
    exceptionReasons: inv.exceptionReasons ?? [],
    failureReason: inv.failureReason,
    processingMs: inv.processingMs,
    processedAt: inv.processedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    tags: inv.tags ? inv.tags.map((t: any) => t.tag.name) : undefined,
  };
}

export function presentLineItem(l: any) {
  return { id: l.id, description: l.description, quantity: num(l.quantity), unitPrice: num(l.unitPrice), taxRate: num(l.taxRate), taxAmount: num(l.taxAmount), lineTotal: num(l.lineTotal) };
}
