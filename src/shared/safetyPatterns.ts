// src/shared/safetyPatterns.ts
// The word patterns the safety decisions match on, in one place: the bot-check refusal (the MCP
// server and the input dispatcher both refuse a bot check) and the high-risk action labels (the
// confirmation gate asks the user before a payment or a destructive click).

/** What a bot check or CAPTCHA control says. Tarka never clicks or solves one: a person must. */
export const BOT_CHECK_PATTERN = /verify (?:that )?you(?: are|'re) (?:a )?human|i'?m not a robot|are you a robot|captcha|human verification|bot check|challenges\.cloudflare\.com|turnstile/i;

/**
 * The labels of a control whose click or submit can spend money, order something or destroy an
 * account. A click or a submitting type on such a control asks the user first, whatever the page
 * the model read told it to do.
 */
export const HIGH_RISK_ACTION_PATTERN = /\b(pay|purchase|buy now|checkout|place order|submit order|transfer|delete account)\b/i;

/** The hard refusal of typing into a masked field (a password, a card or a one-time code field). */
export const MASKED_TYPE_REFUSAL = 'Refused by security policy: cannot type into or read sensitive credential, payment card, or OTP fields. Ask the user to enter this field manually.';

/** The hard refusal of clicking or focusing a masked field. */
export const MASKED_CLICK_REFUSAL = 'Refused by security policy: cannot click or focus a sensitive credential, payment card, or OTP field. Ask the user to fill this field manually.';
