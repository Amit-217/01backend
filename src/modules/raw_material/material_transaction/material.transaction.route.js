const express = require('express');
const authenticate = require('../../../common/middlewares/authenticate');
const authorizeAdmin = require('../../../common/middlewares/authorizeAdmin');
const validate = require('../../../common/middlewares/validate');
const {
  createTransaction,
  listTransactions,
  listHistory,
  getSubmission,
  getTransaction,
  reverseTransaction,
  listAudit,
  getAudit,
  listActors,
} = require('./material.transaction.controller');
const { createMaterialTransactionValidation } = require('./material.transaction.validation');

const router = express.Router();

router.use(authenticate);
router.get('/', listTransactions);
router.post('/', validate(createMaterialTransactionValidation), (req, res, next) => {
  if (req.body.type === 'ADJUSTMENT' || req.body.type === 'OPENING') return authorizeAdmin(req, res, next);
  return next();
}, createTransaction);
router.get('/audit', authorizeAdmin, listAudit);
router.get('/audit/actors', authorizeAdmin, listActors);
router.get('/audit/:id', authorizeAdmin, getAudit);
router.get('/history', listHistory);
router.get('/submissions/:key', getSubmission);
router.get('/:id', getTransaction);
// Stock history is append-only: corrections are made with a reversal, never a delete.
router.post('/:id/reverse', authorizeAdmin, reverseTransaction);

module.exports = router;
