require("dotenv").config();
const nodemailer = require("nodemailer");
let configuredEmail;

const createTransporter = () => {
  const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM } = process.env;

  if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASS) {
    return null;
  }
  if (configuredEmail) return configuredEmail;

  const transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: Number(EMAIL_PORT) || 587,
    secure: Number(EMAIL_PORT) === 465,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });

  configuredEmail = {
    transporter,
    from: EMAIL_FROM || EMAIL_USER,
  };
  return configuredEmail;
};

module.exports = {
  createTransporter,
};
