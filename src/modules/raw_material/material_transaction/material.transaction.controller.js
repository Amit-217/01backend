const { asyncHandler } = require('../../../common/utils/errors');
const { sendSuccess, sendError } = require('../../../common/utils/response');
const {
  listMaterialTransactions,
  createMaterialTransaction,
  getMaterialTransactionById,
  reverseMaterialTransactionById,
} = require('./material.transaction.service');
const { tenantActorFields, listMovementAudit, getMovementAudit, listMovementActors } = require('./movement.audit');

const createTransaction = asyncHandler(async (req, res) => {
  const transaction = await createMaterialTransaction({
    ...req.body,
    tenantId: req.user.tenantId,
    createdBy: req.user.userId,
    ...tenantActorFields(req.user),
    idempotencyKey: req.get('Idempotency-Key'),
  });

  return sendSuccess(res, 201, 'Material transaction created successfully.', transaction);
});

const listTransactions = asyncHandler(async (req, res) => {
  const transactions = await listMaterialTransactions(req.user.tenantId, req.query);
  return sendSuccess(res, 200, 'Material transactions retrieved successfully.', transactions);
});

const getTransaction = asyncHandler(async (req, res) => {
  const transaction = await getMaterialTransactionById(req.params.id, req.user.tenantId);

  if (!transaction) {
    return sendError(res, 404, 'Transaction not found.');
  }

  return sendSuccess(res, 200, 'Material transaction retrieved successfully.', transaction);
});

const reverseTransaction = asyncHandler(async (req, res) => {
  const transaction = await reverseMaterialTransactionById(
    req.params.id,
    req.user.tenantId,
    req.user.userId,
    tenantActorFields(req.user),
  );
  if (!transaction) return sendError(res, 404, 'Transaction not found.');
  return sendSuccess(res, 201, 'Stock movement reversed.', transaction);
});

const listAudit = asyncHandler(async (req, res) =>
  sendSuccess(res, 200, 'Movement audit retrieved.', await listMovementAudit(req.user.tenantId, req.query)));

const getAudit = asyncHandler(async (req, res) =>
  sendSuccess(res, 200, 'Movement detail retrieved.', await getMovementAudit(req.user.tenantId, req.params.id)));

const listActors = asyncHandler(async (req, res) =>
  sendSuccess(res, 200, 'Movement actors retrieved.', await listMovementActors(req.user.tenantId)));

module.exports = {
  createTransaction,
  listTransactions,
  getTransaction,
  reverseTransaction,
  listAudit,
  getAudit,
  listActors,
};
