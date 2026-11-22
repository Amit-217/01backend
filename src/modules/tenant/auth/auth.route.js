const express = require('express');
const { rateLimit } = require('express-rate-limit');
const authController = require('./auth.controller');
const authenticate = require('../../../common/middlewares/authenticate');
const validate = require('../../../common/middlewares/validate');
const { requireWebOrigin, readWebRefresh } = require('./auth.web');
const { registerValidation, verifyEmailValidation, adminEmailValidation, loginValidation, refreshTokenValidation, forgotPasswordValidation, resetPasswordValidation, resendOtpValidation } = require('./auth.validation');

const router = express.Router();
const publicAuthLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again in a few minutes.' },
});

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     summary: Register a tenant with a company email
 *     responses:
 *       201:
 *         description: Registration started
 */
router.post('/register', publicAuthLimit, validate(registerValidation), authController.register);
router.post('/verify-email', publicAuthLimit, validate(verifyEmailValidation), authController.verifyEmail);
router.post('/send-admin-email-verification', publicAuthLimit, validate(adminEmailValidation), authController.sendAdminEmailVerification);
router.post('/verify-admin-email', publicAuthLimit, validate(adminEmailValidation), authController.verifyAdminEmail);
router.post('/register-admin', publicAuthLimit, validate(adminEmailValidation), authController.registerAdmin);
router.post('/finalize-registration', publicAuthLimit, validate(adminEmailValidation), authController.registerAdmin);
router.post('/login', requireWebOrigin, publicAuthLimit, validate(loginValidation), authController.login);
router.post('/refresh-token', requireWebOrigin, readWebRefresh, validate(refreshTokenValidation), authController.refreshToken);
router.post('/logout', requireWebOrigin, authenticate, authController.logout);
router.post('/forgot-password', publicAuthLimit, validate(forgotPasswordValidation), authController.forgotPassword);
router.post('/verify-reset-otp', publicAuthLimit, validate(verifyEmailValidation), authController.verifyResetOtp);
router.post('/reset-password', publicAuthLimit, validate(resetPasswordValidation), authController.resetPassword);
router.post('/resend-otp', publicAuthLimit, validate(resendOtpValidation), authController.resendOtp);

module.exports = router;
