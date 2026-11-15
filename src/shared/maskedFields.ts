// src/shared/maskedFields.ts
// The field kinds whose value must never be read as text and never shown as pixels: a password,
// a payment card field and a one-time code. One constant for every side that decides from it -
// the element list and the effect probe in the content script, the screenshot mask, and the
// background's security gate - so the three paths cannot drift apart.

export const MASKED_FIELD_KINDS: ReadonlySet<string> = new Set(['password', 'cc', 'otp']);
