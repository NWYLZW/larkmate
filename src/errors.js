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

export function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FeishuError('INVALID_ARGUMENT', `${label} must not be empty.`);
  }
  return value;
}
