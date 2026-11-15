
export const BOT_CHECK_PATTERN = /verify (?:that )?you(?: are|'re) (?:a )?human|i'?m not a robot|are you a robot|captcha|human verification|bot check|challenges\.cloudflare\.com|turnstile/i;

export const HIGH_RISK_ACTION_PATTERN = /\b(pay|purchase|buy now|checkout|place order|submit order|transfer|delete account)\b/i;

export const MASKED_TYPE_REFUSAL = 'Refused by security policy: cannot type into or read sensitive credential, payment card, or OTP fields. Ask the user to enter this field manually.';

export const MASKED_CLICK_REFUSAL = 'Refused by security policy: cannot click or focus a sensitive credential, payment card, or OTP field. Ask the user to fill this field manually.';
