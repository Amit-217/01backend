const assert = require('node:assert/strict');
const { test } = require('node:test');
const { seal, unseal, totpCode, matchStep, base32 } = require('../src/modules/platform/platform.totp');

test('platform authenticator derives the six-digit RFC 6238 code and encrypts its seed', () => {
  process.env.PLATFORM_TOTP_KEY = Buffer.alloc(32, 9).toString('base64');
  const seed = Buffer.from('12345678901234567890');
  assert.equal(totpCode(seed, 1), '287082');
  assert.equal(matchStep(seed, '287082', 59_000), 1);
  assert.equal(matchStep(seed, '287082', 180_000), undefined);
  assert.equal(base32(seed), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const encrypted = seal(seed);
  assert.notEqual(encrypted, seal(seed));
  assert.deepEqual(unseal(encrypted), seed);
});
