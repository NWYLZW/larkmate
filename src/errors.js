export class FeishuError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    this.details = details;
  }
}

export function requireNumericId(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new FeishuError('INVALID_ARGUMENT', `${label} must be a numeric ID from search.`);
  }
  return value;
}

export function requireInt64Id(value, label) {
  requireNumericId(value, label);
  if (value.length > 19 || BigInt(value) < 1n || BigInt(value) > 9223372036854775807n) {
    throw new FeishuError('INVALID_ARGUMENT', `${label} must be a positive 64-bit ID.`);
  }
  return value;
}

export function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FeishuError('INVALID_ARGUMENT', `${label} must not be empty.`);
  }
  return value;
}
