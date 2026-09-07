// The service-account JSON reaches a deployment through an environment
// variable, and that trip damages it in a small number of predictable ways.
// Production hit exactly this: GOOGLE_CREDENTIALS was set but unparseable, so
// every sheet-backed feature failed with "Unexpected token ... is not valid
// JSON" and no service account could even be named in the error.
//
// Nothing here prints a key.
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));
const { parseServiceAccountJson } = require(path.join(__dirname, '..', 'src', 'services', 'google.js'));

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  ✗ ${label}\n      got  ${g}\n      want ${w}`);
};
const ok = (fn, label) => {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  ✗ ${label}\n      threw ${e.message}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

// A stand-in shaped like the real thing: the private key is the field that
// carries line breaks, and it is the one that breaks the paste.
const KEY_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\nDbFAKEbFAKEbFAKE\nQwIDAQAB';
const account = {
  type: 'service_account',
  project_id: 'example-1234',
  private_key_id: 'abc123',
  private_key: `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`,
  client_email: 'svc@example-1234.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const ONE_LINE = JSON.stringify(account);
const PRETTY = JSON.stringify(account, null, 2);

// What a paste looks like when the escapes were turned into real line breaks.
const withRealNewlines = (s) => s.replace(/\\n/g, '\n');

section('the value as it should arrive');
eq(parseServiceAccountJson(ONE_LINE).client_email, account.client_email, 'one line, exactly as downloaded');
eq(parseServiceAccountJson(PRETTY).client_email, account.client_email, 'pretty-printed is still valid JSON');
eq(parseServiceAccountJson(`  ${ONE_LINE}  `).client_email, account.client_email, 'surrounding whitespace');

section('the ways it actually arrives');
// This is the production failure, reproduced: JSON.parse rejects a raw newline
// inside a string, which is exactly what a pasted private key contains.
let plainParseFailed = false;
try { JSON.parse(withRealNewlines(ONE_LINE)); } catch (_) { plainParseFailed = true; }
eq(plainParseFailed, true, 'sanity: plain JSON.parse cannot read this — the repair is what saves it');
eq(parseServiceAccountJson(withRealNewlines(ONE_LINE)).private_key, account.private_key,
  'private key with real line breaks is repaired, key text intact');
eq(parseServiceAccountJson(withRealNewlines(PRETTY)).private_key, account.private_key,
  'pretty-printed AND broken key — token breaks kept, string breaks escaped');
eq(parseServiceAccountJson('﻿' + ONE_LINE).client_email, account.client_email, 'byte-order mark');
eq(parseServiceAccountJson(`'${ONE_LINE}'`).client_email, account.client_email, 'wrapped in single quotes');
eq(parseServiceAccountJson(`﻿ ${withRealNewlines(ONE_LINE)} `).client_email, account.client_email,
  'BOM and broken key together');

section('what it refuses to guess at');
let msg = '';
try { parseServiceAccountJson('{"type":"service_account", oops'); } catch (e) { msg = e.message; }
eq(msg.includes('could not be parsed as JSON'), true, 'truncated value is reported, not silently accepted');
eq(msg.includes('one line'), true, 'the message says how to fix it');
eq(/private key/i.test(msg), true, 'and names the field that usually causes it');

section('the repair does not corrupt good data');
const parsed = parseServiceAccountJson(withRealNewlines(ONE_LINE));
eq(parsed.private_key.split('\n').length, account.private_key.split('\n').length, 'same number of key lines');
eq(parsed.type, 'service_account', 'other fields untouched');
eq(parsed.token_uri, account.token_uri, 'urls with // survive the escape scan');

console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
