const express = require('express');
const mongoose = require('mongoose');
const { rateLimit } = require('express-rate-limit');
const { AppError, asyncHandler } = require('../../common/utils/errors');
const { sendSuccess } = require('../../common/utils/response');
const { PlatformStaff, PlatformSession, PlatformAudit } = require('./platform.model');
const { loginPlatform, authenticatePlatform } = require('./platform.auth');
const service = require('./platform.service');
const rules = require('./platform.validation');
const { PLATFORM_ACTOR, listMovementAudit, getMovementAudit, listMovementActors } = require('../raw_material/material_transaction/movement.audit');
const finishedCatalog = require('../finished_goods/product.service');
const finishedLedger = require('../finished_goods/movement.service');
const finishedRules = require('../finished_goods/finished.validation');

const router = express.Router();
const loginLimit = rateLimit({
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError(429, 'Too many platform sign-in attempts. Try again later.')),
});
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, result.error.issues[0].message);
  return result.data;
};
const failureStatus = (error) => error.statusCode || (error.code === 11000 ? 409 : 500);

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/auth/login', loginLimit, asyncHandler(async (req, res) => {
  try {
    const result = await loginPlatform(parse(rules.login, req.body));
    return sendSuccess(res, 200, 'Platform session opened.', result);
  } catch (error) {
    await PlatformAudit.create({ action: 'auth.login', outcome: 'failed', status: failureStatus(error) });
    throw error;
  }
}));

router.use(authenticatePlatform);

const operation = (action, execute, { body, query, write = false, operator = write, delivery = false } = {}) =>
  asyncHandler(async (req, res) => {
    const { staff } = req.platform;
    const rawTenantId = req.params.tenantId;
    const event = {
      staffId: staff._id,
      staffName: staff.name,
      tenantId: rawTenantId?.slice(0, 128),
      action,
      target: (req.params.id || req.params.userId || rawTenantId)?.slice(0, 128),
    };
    const log = (fields, session) => PlatformAudit.create([{ ...event, ...fields }], { session });
    try {
      if (operator && staff.role !== 'operator') throw new AppError(403, 'Platform operator permission is required.');
      if (rawTenantId !== undefined) parse(rules.readableId, rawTenantId);
      if (req.params.userId !== undefined) parse(rules.readableId, req.params.userId);
      if (body) {
        req.body = parse(body, req.body);
        event.caseReference = req.body.caseReference;
        event.reason = req.body.reason;
        if (req.body.status) event.details = 'Requested status ' + req.body.status;
        if (req.body.role) event.details = 'Requested role ' + req.body.role;
        if (req.body.access) event.details = 'Requested access ' + req.body.access;
        if ('paidUntil' in req.body) event.details = 'Paid until ' + (req.body.paidUntil || 'not set');
        if (req.body.outcome) event.details = 'Recovery outcome ' + req.body.outcome;
        if (req.body.correctionOf) event.target = req.body.correctionOf;
      }
      const args = query ? parse(query, req.query) : req.query;
      const run = async (session) => {
        if (operator && !await PlatformStaff.exists({ _id: staff._id, active: true, role: 'operator' }).session(session)) {
          throw new AppError(403, 'Platform operator permission is required.');
        }
        if (rawTenantId) await service.readTenant(rawTenantId, session);
        const result = await execute(req, session, args);
        const record = delivery ? result.data : result;
        const resultId = record?._id || record?.userId || record?.tenantId;
        if (resultId) event.resultId = String(resultId);
        await log({ outcome: delivery ? 'prepared' : 'succeeded', status: 200 }, session);
        return result;
      };
      const result = write ? await mongoose.connection.transaction(run) : await run(null);
      if (delivery) {
        await result.deliver();
        await log({ outcome: 'succeeded', status: 200 });
      }
      return sendSuccess(res, 200, 'Platform operation completed.', delivery ? result.data : result);
    } catch (error) {
      await log({ outcome: 'failed', status: failureStatus(error) });
      throw error;
    }
  });

router.post('/auth/logout', operation('auth.logout', async (req, session) => {
  await PlatformSession.deleteOne({ _id: req.platform.sessionId, staffId: req.platform.staff._id }, { session });
  return null;
}, { write: true, operator: false }));

router.get('/tenants', operation('tenants.list', (_req, _session, query) => service.listTenants(query),
  { query: rules.directoryQuery }));
router.get('/audit', operation('platform.audit.list', (_req, _session, query) => service.listAudit(undefined, query),
  { query: rules.pageQuery }));
router.get('/tenants/:tenantId', operation('tenant.view', async (req, session) =>
  service.tenantView(await service.readTenant(req.params.tenantId, session))));
router.get('/tenants/:tenantId/users', operation('users.list', (req, _session, query) =>
  service.listUsers(req.params.tenantId, query), { query: rules.pageQuery }));
router.get('/tenants/:tenantId/stock', operation('stock.list', (req, _session, query) =>
  listMovementAudit(req.params.tenantId, query)));
router.get('/tenants/:tenantId/stock/actors', operation('stock.actors', (req) =>
  listMovementActors(req.params.tenantId)));
router.get('/tenants/:tenantId/stock/:id', operation('stock.view', (req) =>
  getMovementAudit(req.params.tenantId, req.params.id)));
router.get('/tenants/:tenantId/materials', operation('materials.list', (req) =>
  service.listMaterials(req.params.tenantId)));
router.get('/tenants/:tenantId/finished-goods/products', operation('finished.products.list', (req) =>
  finishedCatalog.listProducts(req.params.tenantId, true)));
router.get('/tenants/:tenantId/finished-goods/skus', operation('finished.skus.list', (req, _session, query) =>
  finishedCatalog.listSkus(req.params.tenantId, query, true), { query: finishedRules.skuQuery }));
router.get('/tenants/:tenantId/finished-goods/movements', operation('finished.movements.list', (req, _session, query) =>
  finishedLedger.listMovements(req.params.tenantId, query, true), { query: finishedRules.auditQuery }));
router.get('/tenants/:tenantId/finished-goods/movements/actors', operation('finished.movements.actors', (req) =>
  finishedLedger.listActors(req.params.tenantId)));
router.get('/tenants/:tenantId/finished-goods/movements/:id', operation('finished.movements.view', (req) =>
  finishedLedger.getMovement(req.params.tenantId, finishedRules.parse(finishedRules.objectId, req.params.id), true)));
router.get('/tenants/:tenantId/audit', operation('tenant.audit.list', (req, _session, query) =>
  service.listAudit(req.params.tenantId, query), { query: rules.pageQuery }));
router.get('/tenants/:tenantId/changes', operation('changes.list', (req, _session, query) =>
  service.listChanges(req.params.tenantId, query), { query: rules.pageQuery }));

router.post('/tenants/:tenantId/stock/:id/reverse', operation('stock.reverse', service.recordReversal,
  { write: true, body: rules.context }));
router.post('/tenants/:tenantId/stock/adjustment', operation('stock.adjust', service.recordAdjustment,
  { write: true, body: rules.adjustment }));
router.post('/tenants/:tenantId/finished-goods/movements/:id/reverse', operation('finished.movements.reverse',
  async (req, session) => {
    const id = finishedRules.parse(finishedRules.objectId, req.params.id);
    const entry = await finishedLedger.reverseMovement(req.params.tenantId, id, req.body.reason,
      { createdBy: PLATFORM_ACTOR }, session);
    return finishedLedger.movementView(entry, true);
  }, { write: true, body: rules.context }));
router.post('/tenants/:tenantId/finished-goods/movements/adjustment', operation('finished.movements.adjust',
  async (req, session) => {
    const { skuId, correctionOf, direction, quantity, reason, caseReference } = req.body;
    const key = finishedLedger.requireKey(req.get('Idempotency-Key'));
    const scopedKey = finishedLedger.hash(JSON.stringify([String(req.platform.staff._id), key]));
    const entry = await finishedLedger.createMovement(req.params.tenantId, {
      skuId, correctionOf, type: 'ADJUSTMENT', direction, quantity, reason, reference: caseReference,
    }, { createdBy: PLATFORM_ACTOR }, scopedKey, session);
    return finishedLedger.movementView(entry, true);
  }, { write: true, body: rules.context.extend({
    skuId: finishedRules.objectId, correctionOf: finishedRules.objectId,
    direction: finishedRules.direction, quantity: finishedRules.quantity,
  }) }));
router.post('/tenants/:tenantId/status', operation('tenant.status', (req, session) =>
  service.setTenantStatus(req.params.tenantId, req.body.status, session), { write: true, body: rules.status }));
router.post('/tenants/:tenantId/access', operation('tenant.access', (req, session) =>
  service.setAccess(req.params.tenantId, req.body.access, session), { write: true, body: rules.access }));
router.post('/tenants/:tenantId/billing', operation('tenant.billing', (req, session) =>
  service.setBilling(req.params.tenantId, req.body, session), { write: true, body: rules.billing }));
router.post('/tenants/:tenantId/users/:userId/status', operation('user.status', (req, session) =>
  service.changeUser({ ...req.params, status: req.body.status, session }), { write: true, body: rules.status }));
router.post('/tenants/:tenantId/users/:userId/role', operation('user.role', (req, session) =>
  service.changeRole({ ...req.params, role: req.body.role, session }), { write: true, body: rules.role }));
router.post('/tenants/:tenantId/users/:userId/revoke-sessions', operation('user.sessions.revoke', (req, session) =>
  service.changeUser({ ...req.params, session }), { write: true, body: rules.context }));
router.post('/tenants/:tenantId/users/:userId/request-recovery', operation('user.recovery', (req, session) =>
  service.requestRecovery(req.params.tenantId, req.params.userId, session),
  { write: true, body: rules.context, delivery: true }));

router.post('/tenants/:tenantId/changes/stock', operation('change.stock.preview', service.previewStock,
  { write: true, body: rules.bulkStock }));
router.post('/tenants/:tenantId/changes/recovery', operation('change.recovery.preview', service.previewRecovery,
  { write: true, body: rules.recovery }));
router.post('/tenants/:tenantId/changes/:id/approve', operation('change.approve', service.approveChange,
  { write: true, body: rules.context }));
router.post('/tenants/:tenantId/changes/:id/complete', operation('change.recovery.complete', service.completeRecovery,
  { write: true, body: rules.finishRecovery }));

module.exports = router;
