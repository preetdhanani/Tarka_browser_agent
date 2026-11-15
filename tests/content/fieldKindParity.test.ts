/**
 * The field-kind classifier of content/content.js must agree with perception.ts's
 * computeFieldKind, element for element.
 *
 * content.js is a standalone classic script with no imports, so it carries its own copy of the
 * classifier. A copy that drifts from the original would make the screenshot mask and the text
 * path disagree about what a sensitive field is, so this test pins them together through the real
 * message path: the probe's focus.fieldKind (the content.js copy) against computeFieldKind called
 * the way perception.ts calls it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeFieldKind } from '../../src/content/perception.ts';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');

function makeListener(): { dispatch: (action: string, payload?: any) => Promise<any> } {
  const document: any = {
    title: 'Form',
    body: { innerText: 'Form' },
    activeElement: null,
    documentElement: {},
    querySelectorAll: () => [],
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
  };
  const window: any = {
    location: { href: 'https://example.com/form' },
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({}),
  };
  const chrome = { runtime: { onMessage: { addListener: (fn: any) => { (globalThis as any).__tarkaParityListener = fn; } } } };
  new Function('window', 'document', 'chrome', CONTENT_SRC)(window, document, chrome);
  return {
    dispatch: (action: string, payload?: any) => new Promise((resolve) => {
      (globalThis as any).__tarkaParityListener({ action, payload }, {}, (res: any) => resolve(res));
    }),
  };
}

function domEl(spec: { tag: string; attrs?: Record<string, string>; value?: string }): any {
  const attrs = spec.attrs ?? {};
  const getAttribute = (name: string) => (name in attrs ? attrs[name] : null);
  return {
    tagName: spec.tag.toUpperCase(),
    nodeType: 1,
    id: attrs.id ?? '',
    get type() { return attrs.type ?? ''; },
    value: spec.value ?? '',
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    getAttribute,
    closest: () => null,
    labels: null,
  };
}

// Every shape the classifier must tell apart: the three masked kinds by type, name, id and
// autocomplete, the unmasked kinds, and the non-input elements that have no kind at all.
const CASES: Array<{ name: string; spec: { tag: string; attrs?: Record<string, string>; value?: string } }> = [
  { name: 'password by type', spec: { tag: 'input', attrs: { type: 'password' } } },
  { name: 'password by name', spec: { tag: 'input', attrs: { name: 'password' } } },
  { name: 'password by id', spec: { tag: 'input', attrs: { id: 'signupPasswort' } } },
  { name: 'card by name', spec: { tag: 'input', attrs: { name: 'cc-number' } } },
  { name: 'card by id', spec: { tag: 'input', attrs: { id: 'cardNumber' } } },
  { name: 'card cvv', spec: { tag: 'input', attrs: { name: 'cvv' } } },
  { name: 'card kreditkarte', spec: { tag: 'input', attrs: { name: 'kreditkarte' } } },
  { name: 'otp by autocomplete', spec: { tag: 'input', attrs: { autocomplete: 'one-time-code' } } },
  { name: 'otp by name', spec: { tag: 'input', attrs: { name: 'otpCode' } } },
  { name: 'otp by id', spec: { tag: 'input', attrs: { id: 'twofa-code' } } },
  { name: 'otp bare code name', spec: { tag: 'input', attrs: { name: 'code' } } },
  { name: 'otp api token', spec: { tag: 'input', attrs: { name: 'api_token' } } },
  { name: 'otp csrf token', spec: { tag: 'input', attrs: { id: 'csrfToken' } } },
  { name: 'otp verification code', spec: { tag: 'input', attrs: { name: 'verificationCode' } } },
  // A "code" name that names ordinary data must not become a masked field: a postal code, a
  // coupon code or a country code is fillable, and its form raises no confirmation card.
  { name: 'postcode is address', spec: { tag: 'input', attrs: { name: 'postcode' } } },
  { name: 'postal-code is address', spec: { tag: 'input', attrs: { name: 'postal-code' } } },
  { name: 'zip_code is address', spec: { tag: 'input', attrs: { id: 'zip_code' } } },
  { name: 'zipcode is address', spec: { tag: 'input', attrs: { name: 'zipcode' } } },
  { name: 'promo code is text', spec: { tag: 'input', attrs: { name: 'promo_code' } } },
  { name: 'coupon code is text', spec: { tag: 'input', attrs: { name: 'couponCode' } } },
  { name: 'area code is text', spec: { tag: 'input', attrs: { name: 'area_code' } } },
  { name: 'country code is text', spec: { tag: 'input', attrs: { name: 'country-code' } } },
  { name: 'currency code is text', spec: { tag: 'input', attrs: { name: 'currencyCode' } } },
  { name: 'sort code is text', spec: { tag: 'input', attrs: { name: 'sort_code' } } },
  { name: 'email by type', spec: { tag: 'input', attrs: { type: 'email' } } },
  { name: 'email by name', spec: { tag: 'input', attrs: { name: 'email' } } },
  { name: 'search by type', spec: { tag: 'input', attrs: { type: 'search' } } },
  { name: 'search by name', spec: { tag: 'input', attrs: { name: 'query' } } },
  { name: 'address by name', spec: { tag: 'input', attrs: { name: 'street' } } },
  { name: 'plain text', spec: { tag: 'input', attrs: { name: 'username' } } },
  { name: 'bare input', spec: { tag: 'input' } },
  { name: 'textarea plain', spec: { tag: 'textarea', attrs: { name: 'message' } } },
  { name: 'textarea sensitive', spec: { tag: 'textarea', attrs: { name: 'card-notes' } } },
  { name: 'button has no kind', spec: { tag: 'button' } },
  { name: 'select has no kind', spec: { tag: 'select' } },
];

test('the content.js classifier matches perception.ts computeFieldKind on every case', async () => {  for (const { name, spec } of CASES) {
    const el = domEl(spec);
    const expected = computeFieldKind(el, spec.tag, (spec.attrs?.type ?? ''));
    const fixture = makeListener();
    await fixture.dispatch('EFFECT_PROBE_BEGIN');
    const originalActive = el;
    // The probe reads document.activeElement; re-run the script with this element focused.
    const document2: any = {
      title: 'Form',
      body: { innerText: 'Form' },
      activeElement: originalActive,
      documentElement: {},
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => null }),
      elementFromPoint: () => null,
    };
    const window2: any = {
      location: { href: 'https://example.com/form' },
      scrollX: 0,
      scrollY: 0,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: () => {},
      removeEventListener: () => {},
      getComputedStyle: () => ({}),
    };
    const chrome2 = { runtime: { onMessage: { addListener: (fn: any) => { (globalThis as any).__tarkaParityListener = fn; } } } };
    new Function('window', 'document', 'chrome', CONTENT_SRC)(window2, document2, chrome2);
    await (globalThis as any).__tarkaParityListener({ action: 'EFFECT_PROBE_BEGIN' }, {}, () => {});
    const res: any = await new Promise((resolve) => {
      (globalThis as any).__tarkaParityListener({ action: 'EFFECT_PROBE_END' }, {}, (r: any) => resolve(r));
    });
    const got = res?.detail?.focus?.fieldKind;
    assert.equal(got, expected, `case "${name}": content.js said ${JSON.stringify(got)}, perception.ts says ${JSON.stringify(expected)}`);
  }
});

// The kinds themselves, not only the agreement of the two copies: a "code" name that names
// ordinary data (a postal code, a coupon code) must stay fillable, while a field that can hold a
// secret the user must type stays masked. Hardcoded expectations, so a shared bug in both copies
// cannot pass.
const EXPECTED: Array<{ spec: { tag: string; attrs?: Record<string, string> }; kind: string | undefined; why: string }> = [
  { spec: { tag: 'input', attrs: { name: 'postcode' } }, kind: 'address', why: 'a postal code is address data, not a one-time code' },
  { spec: { tag: 'input', attrs: { name: 'postal-code' } }, kind: 'address', why: 'a hyphenated postal code is address data' },
  { spec: { tag: 'input', attrs: { id: 'zip_code' } }, kind: 'address', why: 'a zip code is address data' },
  { spec: { tag: 'input', attrs: { name: 'zipcode' } }, kind: 'address', why: 'a zip code is address data' },
  { spec: { tag: 'input', attrs: { name: 'promo_code' } }, kind: 'text', why: 'a coupon code is fillable' },
  { spec: { tag: 'input', attrs: { name: 'couponCode' } }, kind: 'text', why: 'a coupon code is fillable' },
  { spec: { tag: 'input', attrs: { name: 'area_code' } }, kind: 'text', why: 'a phone area code is fillable' },
  { spec: { tag: 'input', attrs: { name: 'country-code' } }, kind: 'text', why: 'a country code is fillable' },
  { spec: { tag: 'input', attrs: { name: 'currencyCode' } }, kind: 'text', why: 'a currency code is fillable' },
  { spec: { tag: 'input', attrs: { name: 'sort_code' } }, kind: 'text', why: 'a bank sort code is fillable data, not a delivered secret' },
  { spec: { tag: 'input', attrs: { name: 'code' } }, kind: 'otp', why: 'a bare code field stays masked: it may hold a one-time code' },
  { spec: { tag: 'input', attrs: { name: 'api_token' } }, kind: 'otp', why: 'an API token is a secret' },
  { spec: { tag: 'input', attrs: { id: 'csrfToken' } }, kind: 'otp', why: 'a CSRF token is a secret' },
  { spec: { tag: 'input', attrs: { name: 'verificationCode' } }, kind: 'otp', why: 'a verification code is a delivered secret' },
  { spec: { tag: 'input', attrs: { autocomplete: 'one-time-code' } }, kind: 'otp', why: 'the standard one-time-code autocomplete stays masked' },
  // camelCase names must stay masked too: the classifier lowercases, so a boundary rule that
  // demands a separator would silently unmask the most common OTP naming there is.
  { spec: { tag: 'input', attrs: { name: 'otpCode' } }, kind: 'otp', why: 'camelCase OTP naming stays masked' },
  { spec: { tag: 'input', attrs: { name: '2faCode' } }, kind: 'otp', why: 'camelCase two-factor naming stays masked' },
  { spec: { tag: 'input', attrs: { name: 'mfaCode' } }, kind: 'otp', why: 'camelCase MFA naming stays masked' },
  { spec: { tag: 'input', attrs: { name: 'smsOtp' } }, kind: 'otp', why: 'camelCase SMS OTP naming stays masked' },
  { spec: { tag: 'input', attrs: { id: 'myOtp' } }, kind: 'otp', why: 'an otp suffix stays masked' },
  // A code the user receives by email is a one-time secret, even though the name says email.
  { spec: { tag: 'input', attrs: { name: 'email_code' } }, kind: 'otp', why: 'an emailed code is a secret' },
  { spec: { tag: 'input', attrs: { name: 'emailCode' } }, kind: 'otp', why: 'an emailed code is a secret' },
  { spec: { tag: 'input', attrs: { name: 'emailOtp' } }, kind: 'otp', why: 'an emailed OTP is a secret' },
  { spec: { tag: 'input', attrs: { type: 'email', name: 'login_email' } }, kind: 'email', why: 'a plain email field stays fillable' },
  // German place names are address data, not something else: the standalone rule for "ort" must
  // keep the compounds that carry it.
  { spec: { tag: 'input', attrs: { name: 'wohnort' } }, kind: 'address', why: 'a residence field is address data' },
  { spec: { tag: 'input', attrs: { name: 'geburtsort' } }, kind: 'address', why: 'a birthplace field is address data' },
];

test('the classifier kinds are right, not only agreed upon: benign code names stay fillable', async () => {
  for (const { spec, kind, why } of EXPECTED) {
    const el = domEl(spec);
    const got = computeFieldKind(el, spec.tag, spec.attrs?.type ?? '');
    assert.equal(got, kind, `${spec.attrs?.name || spec.attrs?.id || spec.attrs?.autocomplete || spec.tag}: ${why} (got ${JSON.stringify(got)})`);
  }
});

// Two more pinned kinds: a passcode is a secret, and a bare TAN field (German banking) is one too.
const EXPECTED_MORE: Array<{ spec: { tag: string; attrs?: Record<string, string> }; kind: string | undefined; why: string }> = [
  { spec: { tag: 'input', attrs: { name: 'passcode' } }, kind: 'otp', why: 'a passcode is a secret the user types in' },
  { spec: { tag: 'input', attrs: { name: 'tan' } }, kind: 'otp', why: 'a TAN is a one-time code the user types in' },
];

test('a passcode and a TAN field stay masked', async () => {
  for (const { spec, kind, why } of EXPECTED_MORE) {
    const el = domEl(spec);
    const got = computeFieldKind(el, spec.tag, spec.attrs?.type ?? '');
    assert.equal(got, kind, `${spec.attrs?.name}: ${why} (got ${JSON.stringify(got)})`);
  }
});
