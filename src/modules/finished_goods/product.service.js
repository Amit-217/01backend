const { AppError } = require('../../common/utils/errors');
const { withStockTransaction } = require('../../common/utils/stock');
const { FinishedProduct, FinishedSku, FinishedMovement } = require('./finished.model');

const productView = ({ _id, name, unit, isActive }) => ({ _id, name, unit, isActive });
const skuView = ({ _id, code, reservedCodes, size, colour, unit, currentStock, isActive }, product) => ({
  _id, productId: product._id, productName: product.name, code, size, colour, unit, currentStock, isActive,
  aliases: (reservedCodes ?? []).filter((reserved) => reserved !== code),
});
const visible = (includeArchived) => includeArchived ? {} : { isActive: true };
const productMissing = () => new AppError(404, 'Product not found.');
const skuMissing = () => new AppError(404, 'SKU not found.');
const normalizedLabel = (value) => (value ?? '').trim().replace(/\s+/g, ' ');
const labelKey = (value) => normalizedLabel(value).toLowerCase();
const escapePattern = (value) => value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
const nameConflict = () => new AppError(409, 'A product with this name and stock unit already exists. Check the catalog for it.');
const codeConflict = () => new AppError(409, 'This SKU code already belongs to another SKU, including historical codes.');
const mapCatalogConflict = (error) => {
  if (error.code === 11000 && error.keyPattern?.nameKey) throw nameConflict();
  if (error.code === 11000 && (error.keyPattern?.code || error.keyPattern?.reservedCodes)) throw codeConflict();
  throw error;
};

const assertProductNameAvailable = async (tenantId, { name, unit, _id }, session = null) => {
  // Match product names created before the normalized key was added.
  const pattern = labelKey(name).split(' ').map(escapePattern).join('\\s+');
  if (await FinishedProduct.exists({
    tenantId, unit, name: new RegExp('^\\s*' + pattern + '\\s*$', 'i'), ...(_id ? { _id: { $ne: _id } } : {}),
  }).session(session)) throw nameConflict();
};

const assertCodeAvailable = async (tenantId, code, session, skuId) => {
  const current = await FinishedSku.exists({
    tenantId, $or: [{ code }, { reservedCodes: code }], ...(skuId ? { _id: { $ne: skuId } } : {}),
  }).session(session);
  if (current || await FinishedMovement.exists({
    tenantId, skuCode: code, ...(skuId ? { skuId: { $ne: skuId } } : {}),
  }).session(session)) throw codeConflict();
};

const variantKey = ({ size, colour }) => JSON.stringify([labelKey(size), labelKey(colour)]);
const variantFields = (input) => ({
  ...(input.size === undefined ? {} : { size: normalizedLabel(input.size) }),
  ...(input.colour === undefined ? {} : { colour: normalizedLabel(input.colour) }),
});

const assertVariantAvailable = async (tenantId, productId, variant, session, excludeId) => {
  // Code-only SKUs remain valid. A named variant must be distinct within its product.
  if (!labelKey(variant.size) && !labelKey(variant.colour)) return;
  const match = variantKey(variant);
  const existing = await FinishedSku.find({
    tenantId, productId, isActive: true, ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).select('size colour').session(session).lean();
  if (existing.some((row) => variantKey(row) === match)) {
    throw new AppError(409, 'An active SKU with this size and colour already exists for the product.');
  }
};

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

const createProduct = async (tenantId, input) => {
  const name = normalizedLabel(input.name);
  await assertProductNameAvailable(tenantId, { name, unit: input.unit });
  const product = await FinishedProduct.create({ tenantId, ...input, name, nameKey: labelKey(name) }).catch(mapCatalogConflict);
  return productView(product);
};

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
  if (input.isActive !== undefined) product.isActive = input.isActive;
  if (input.name !== undefined) {
    const name = normalizedLabel(input.name);
    if (labelKey(name) !== labelKey(product.name)) {
      await assertProductNameAvailable(tenantId, { name, unit: product.unit, _id: product._id }, session);
      product.nameKey = labelKey(name);
    }
    product.name = name;
  }
  await product.save({ session });
  return productView(product);
}).catch(mapCatalogConflict);

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
  await assertCodeAvailable(tenantId, input.code, session);
  const variant = variantFields(input);
  await assertVariantAvailable(tenantId, input.productId, variant, session);
  const [sku] = await FinishedSku.create([{
    tenantId, ...input, ...variant, unit: product.unit, reservedCodes: [input.code],
  }], { session });
  return skuView(sku, product);
}).catch(mapCatalogConflict);

const updateSku = (tenantId, id, input) => withStockTransaction(async (session) => {
  const sku = await FinishedSku.findOne({ tenantId, _id: id }).session(session);
  if (!sku) throw skuMissing();
  const product = await lockProduct(tenantId, sku.productId, session);
  if (input.isActive === true && !product.isActive) throw new AppError(409, 'Restore the product before restoring the SKU.');
  if (input.isActive === false && sku.currentStock !== 0) throw new AppError(409, 'Bring stock to zero before archiving the SKU.');
  const fields = variantFields(input);
  const variant = { size: sku.size, colour: sku.colour, ...fields };
  const changedVariant = variantKey(variant) !== variantKey(sku);
  if (changedVariant && (sku.currentStock !== 0 || await FinishedMovement.exists({ tenantId, skuId: sku._id }).session(session))) {
    throw new AppError(409, 'Size and colour cannot change after stock is recorded. Create a SKU for the other variant.');
  }
  if ((input.isActive ?? sku.isActive) && (changedVariant || !sku.isActive)) {
    await assertVariantAvailable(tenantId, sku.productId, variant, session, sku._id);
  }
  if (input.code !== undefined && input.code !== sku.code) {
    await assertCodeAvailable(tenantId, input.code, session, sku._id);
    sku.reservedCodes = [...new Set([...(sku.reservedCodes ?? []), sku.code, input.code])];
  }
  sku.set({ ...input, ...fields });
  await sku.save({ session });
  return skuView(sku, product);
}).catch(mapCatalogConflict);

const historyOptions = async (tenantId) => {
  const [products, skus] = await Promise.all([listProducts(tenantId, true), listSkus(tenantId, {}, true)]);
  return {
    products: products.map(({ _id, name, isActive }) => ({ _id, name, isActive })),
    skus: skus.map(({ _id, productId, productName, code, aliases, size, colour, isActive }) => ({
      _id, productId, productName, code, aliases, size, colour, isActive,
    })),
  };
};

module.exports = { listProducts, getProduct, createProduct, updateProduct, listSkus, getSku, createSku, updateSku, historyOptions };
