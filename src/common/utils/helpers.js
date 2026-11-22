const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes, randomInt } = require('node:crypto');

const developmentAccessSecret = randomBytes(48).toString('base64url');

const getAccessTokenSecret = () => {
  const configured = process.env.JWT_ACCESS_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_ACCESS_SECRET is required in production.');
  }
  return developmentAccessSecret;
};

const normalizeEmail = (email = '') => String(email).trim().toLowerCase();

const generateOtp = (length = 6) => {
  let otp = '';

  for (let i = 0; i < length; i += 1) {
    otp += randomInt(10);
  }

  return otp;
};

const hashPassword = async (password) => bcrypt.hash(password, 10);

const comparePassword = async (password, hash) => bcrypt.compare(password, hash);

const signAccessToken = (payload) =>
  jwt.sign(payload, getAccessTokenSecret(), {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m',
  });

module.exports = {
  normalizeEmail,
  generateOtp,
  hashPassword,
  comparePassword,
  signAccessToken,
  getAccessTokenSecret,
};
