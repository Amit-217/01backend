const {
  createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual,
} = require('node:crypto');
const { AppError } = require('../../common/utils/errors');
const requiresTotp = () => process.env.PLATFORM_REQUIRE_TOTP !== 'false';

const key = () => {
  const value = Buffer.from(process.env.PLATFORM_TOTP_KEY || '', 'base64');
  if (value.length !== 32) throw new AppError(503, 'Platform authentication is unavailable.');
  return value;
};

const seal = (secret) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString('base64url')).join('.');
};

const unseal = (stored) => {
  const [iv, tag, ciphertext] = stored.split('.').map((value) => Buffer.from(value, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

// RFC 6238 with SHA-1, six digits and a 30-second step for authenticator compatibility.
const totpCode = (secret, step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
};

const matchStep = (secret, code, now = Date.now()) => {
  if (!/^\d{6}$/.test(code)) return undefined;
  const step = Math.floor(now / 30_000);
  const actual = Buffer.from(code);
  return [step, step - 1, step + 1].find((value) => value >= 0
    && timingSafeEqual(actual, Buffer.from(totpCode(secret, value))));
};

const base32 = (secret) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let remainder = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of secret) {
    remainder = (remainder << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(remainder >> bits) & 31];
    }
  }
  if (bits) encoded += alphabet[(remainder << (5 - bits)) & 31];
  return encoded;
};

module.exports = { requiresTotp, seal, unseal, totpCode, matchStep, base32 };
