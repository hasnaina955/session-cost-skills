export const REPORT_SCHEMA_VERSION = 1;

export function validateReportShape(report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { valid: false, errors: ['report must be an object'] };
  }
  if (!Number.isInteger(report.schemaVersion) || report.schemaVersion < 1) errors.push('schemaVersion must be a positive integer');
  if (typeof report.generatedAt !== 'string' || Number.isNaN(Date.parse(report.generatedAt))) errors.push('generatedAt must be an ISO date string');
  if (!report.snapshot || typeof report.snapshot !== 'object') errors.push('snapshot must be an object');
  if (!report.usage || typeof report.usage !== 'object') errors.push('usage must be an object');
  if (!report.billing || typeof report.billing !== 'object') errors.push('billing must be an object');
  if (report.usage && (!Number.isFinite(Number(report.usage.totalTokens)) || Number(report.usage.totalTokens) < 0)) errors.push('usage.totalTokens must be a non-negative number');
  if (report.snapshot && typeof report.snapshot.active !== 'boolean') errors.push('snapshot.active must be boolean');
  if (report.snapshot && (typeof report.snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(report.snapshot.capturedAt)))) errors.push('snapshot.capturedAt must be an ISO date string');
  if (report.billing && typeof report.billing.classification !== 'string') errors.push('billing.classification must be a string');
  return { valid: errors.length === 0, errors };
}

export function assertReportShape(report) {
  const result = validateReportShape(report);
  if (!result.valid) throw new Error(`Invalid session-cost report: ${result.errors.join('; ')}`);
  return report;
}
