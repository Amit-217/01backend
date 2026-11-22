const express = require('express');
const { getCurrentTenant } = require('./tenant.controller');
const authenticate = require('../../../common/middlewares/authenticate');

const router = express.Router();

// Companies are created only through the verified signup flow in /api/auth.
router.get('/me', authenticate, getCurrentTenant);

module.exports = router;
