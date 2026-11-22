const { AppError } = require('../../common/utils/errors');
const { withStockTransaction } = require('../../common/utils/stock');
const { FinishedProduct, FinishedSku } = require('./finished.model');

const productView = ({ _id, name, unit, isActive }) => ({ _id, name, unit, isActive });
const skuView = ({ _id, code, size, colour, unit, currentStock, isActive }, product) => ({
  _id, productId: product._id, productName: product.name, code, size, colour, unit, currentStock, isActive,
});
const visible = (includeArchived) => includeArchived ? {} : { isActive: true };
const productMissing = () => new AppError(404, 'Product not found.');
const skuMissing = () => new AppError(404, 'SKU not found.');

const listProducts = async (tenantId, includeArchived) => {
  const products = await FinishedProduct.find({ tenantId, ...visible(includeArchived) })
    .select('name unit isActive').sort({ name: 1, _id: 1 }).lean();
  return products.map(productView);
};

const getProduct = async (tenantId, id, includeArchived) => {
  const product = await FinishedProduct.findOne({ tenantId, _id: id, ...visible(includeArchived) }).lean();
  if (!product) throw productMissing();
  return productView(product);
};

const createProduct = async (tenantId, input) => productView(await FinishedProduct.create({ tenantId, ...input }));

// A parent write serializes product archival with SKU creation and reactivation.
const lockProduct = async (tenantId, id, session) => {
  const product = await FinishedProduct.findOneAndUpdate({ tenantId, _id: id }, {
    $inc: { skuRevision: 1 },
  }, { session, new: true });
  if (!product) throw productMissing();
  return product;
};

const updateProduct = (tenantId, id, input) => withStockTransaction(async (session) => {
  const product = await lockProduct(tenantId, id, session);
  if (input.isActive === false && product.isActive && await FinishedSku.exists({
    tenantId, productId: id, isActive: true,
  }).session(session)) {
    throw new AppError(409, 'Archive the product’s active SKUs first.');
  }
  product.set(input);
  await product.save({ session });
  return productView(product);
});

const skuPopulation = (tenantId, includeArchived) => ({
  path: 'productId', select: 'name', match: { tenantId, ...visible(includeArchived) },
});

const listSkus = async (tenantId, { productId }, includeArchived) => {
  const filter = { tenantId, ...visible(includeArchived) };
  if (productId) filter.productId = productId;
  const rows = await FinishedSku.find(filter).populate(skuPopulation(tenantId, includeArchived))
    .sort({ code: 1 }).lean();
  return rows.filter((row) => row.productId).map((row) => skuView(row, row.productId));
};

const getSku = async (tenantId, id, includeArchived) => {
  const sku = await FinishedSku.findOne({ tenantId, _id: id, ...visible(includeArchived) })
    .populate(skuPopulation(tenantId, includeArchived)).lean();
  if (!sku?.productId) throw skuMissing();
  return skuView(sku, sku.productId);
};

const createSku = (tenantId, input) => withStockTransaction(async (session) => {
  const product = await lockProduct(tenantId, input.productId, session);
  if (!product.isActive) throw new AppError(409, 'Restore the product before adding a SKU.');
  const [sku] = await FinishedSku.create([{ tenantId, ...input, unit: product.unit }], { session });
  return skuView(sku, product);
});

const updateSku = (tenantId, id, input) => withStockTransaction(async (session) => {
  const sku = await FinishedSku.findOne({ tenantId, _id: id }).session(session);
  if (!sku) throw skuMissing();
  const product = await lockProduct(tenantId, sku.productId, session);
  if (input.isActive === true && !product.isActive) throw new AppError(409, 'Restore the product before restoring the SKU.');
  if (input.isActive === false && sku.currentStock !== 0) throw new AppError(409, 'Bring stock to zero before archiving the SKU.');
  sku.set(input);
  await sku.save({ session });
  return skuView(sku, product);
});

module.exports = { listProducts, getProduct, createProduct, updateProduct, listSkus, getSku, createSku, updateSku };
