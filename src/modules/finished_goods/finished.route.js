const express = require('express');
const { z } = require('zod');
const authenticate = require('../../common/middlewares/authenticate');
const authorizeAdmin = require('../../common/middlewares/authorizeAdmin');
const validate = require('../../common/middlewares/validate');
const { asyncHandler } = require('../../common/utils/errors');
const { sendSuccess } = require('../../common/utils/response');
const { tenantActorFields } = require('../raw_material/material_transaction/movement.audit');
const catalog = require('./product.service');
const ledger = require('./movement.service');
const rules = require('./finished.validation');

const router = express.Router();
const admin = (req) => req.user.role === 'admin';
const id = (req) => rules.parse(rules.objectId, req.params.id);
const actor = (req) => ({ createdBy: req.user.userId, ...tenantActorFields(req.user) });
const reply = (message, action, status = 200) => asyncHandler(async (req, res) =>
  sendSuccess(res, status, message, await action(req)));

router.use(authenticate);

router.get('/products', reply('Products retrieved.', (req) => {
  rules.parse(rules.noQuery, req.query);
  return catalog.listProducts(req.user.tenantId, admin(req));
}));
router.get('/products/:id', reply('Product retrieved.', (req) => catalog.getProduct(req.user.tenantId, id(req), admin(req))));
router.post('/products', authorizeAdmin, validate(rules.createProduct),
  reply('Product created.', (req) => catalog.createProduct(req.user.tenantId, req.body), 201));
router.patch('/products/:id', authorizeAdmin, validate(rules.updateProduct),
  reply('Product updated.', (req) => catalog.updateProduct(req.user.tenantId, id(req), req.body)));

router.get('/skus', reply('SKUs retrieved.', (req) =>
  catalog.listSkus(req.user.tenantId, rules.parse(rules.skuQuery, req.query), admin(req))));
router.get('/skus/:id', reply('SKU retrieved.', (req) => catalog.getSku(req.user.tenantId, id(req), admin(req))));
router.post('/skus', authorizeAdmin, validate(rules.createSku),
  reply('SKU created.', (req) => catalog.createSku(req.user.tenantId, req.body), 201));
router.patch('/skus/:id', authorizeAdmin, validate(rules.updateSku),
  reply('SKU updated.', (req) => catalog.updateSku(req.user.tenantId, id(req), req.body)));

router.get('/movements', reply('Finished-goods history retrieved.', (req) =>
  ledger.listMovements(req.user.tenantId, rules.parse(rules.publicQuery, req.query), false)));
router.get('/movements/audit', authorizeAdmin, reply('Finished-goods audit retrieved.', (req) =>
  ledger.listMovements(req.user.tenantId, rules.parse(rules.auditQuery, req.query), true)));
router.get('/movements/audit/actors', authorizeAdmin, reply('Actors retrieved.', (req) => ledger.listActors(req.user.tenantId)));
router.get('/movements/audit/:id', authorizeAdmin, reply('Movement retrieved.', (req) =>
  ledger.getMovement(req.user.tenantId, id(req), true)));
router.get('/movements/filter-options', reply('Finished history options retrieved.', (req) =>
  catalog.historyOptions(req.user.tenantId)));
router.get('/movements/submissions/:key', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, reply('Finished stock submission retrieved.', (req) =>
  ledger.getSubmission(req.user.tenantId, req.user.userId, req.params.key, admin(req))));
router.get('/movements/:id', reply('Movement retrieved.', (req) => ledger.getMovement(req.user.tenantId, id(req), false)));

router.post('/movements', validate(rules.movement), (req, res, next) => {
  if (req.body.type === 'OPENING' || req.body.type === 'ADJUSTMENT') return authorizeAdmin(req, res, next);
  next();
}, reply('Finished-goods movement recorded.', async (req) => {
  const movement = await ledger.createMovement(req.user.tenantId, req.body, actor(req), req.get('Idempotency-Key'));
  return ledger.movementView(movement, admin(req));
}, 201));
router.post('/movements/:id/reverse', authorizeAdmin, validate(z.strictObject({ reason: rules.reason })),
  reply('Finished-goods movement reversed.', async (req) => {
    const movement = await ledger.reverseMovement(req.user.tenantId, id(req), req.body.reason, actor(req));
    return ledger.movementView(movement, true);
  }, 201));

module.exports = router;
