const RawMaterial = require('./raw.material.model');
const RawMaterialCategory = require('../category/category.model');
const MaterialTransaction = require('../material_transaction/material.transaction.model');
const { AppError } = require('../../../common/utils/errors');

const findActiveCategory = async (categoryId, tenantId) => {
  const category = await RawMaterialCategory.findOne({ _id: categoryId, tenantId });
  if (!category) throw new AppError(404, 'Category not found in this tenant.');
  if (category.isActive === false) throw new AppError(400, 'Category is inactive.');
  return category;
};

const listRawMaterials = async (tenantId) => {
  return RawMaterial.find({ tenantId }).populate('categoryId', 'name').sort({ createdAt: -1 });
};

const createRawMaterial = async ({ tenantId, code, name, categoryId, unit, minimumStock }) => {
  const materialCode = String(code || '').trim().toUpperCase();
  const materialName = String(name || '').trim();

  if (!materialCode) {
    throw new AppError(400, 'Material code is required.');
  }

  if (!materialName) {
    throw new AppError(400, 'Material name is required.');
  }

  await findActiveCategory(categoryId, tenantId);

  const existingMaterial = await RawMaterial.findOne({ tenantId, code: materialCode });
  if (existingMaterial) {
    throw new AppError(409, 'A raw material with this code already exists in this tenant.');
  }

  return RawMaterial.create({
    tenantId,
    code: materialCode,
    name: materialName,
    categoryId,
    unit,
    minimumStock: Number(minimumStock ?? 0),
    currentStock: 0,
    isActive: true,
  });
};

const getRawMaterialById = async (id, tenantId) => {
  return RawMaterial.findOne({ _id: id, tenantId }).populate('categoryId', 'name');
};

const updateRawMaterialById = async (id, tenantId, payload) => {
  const material = await RawMaterial.findOne({ _id: id, tenantId });

  if (!material) {
    return null;
  }

  // Keeping an existing (possibly inactive) category is allowed; moving to another one requires it to be active.
  if (payload.categoryId && String(payload.categoryId) !== String(material.categoryId)) {
    await findActiveCategory(payload.categoryId, tenantId);
    material.categoryId = payload.categoryId;
  }

  if (payload.code !== undefined) {
    const code = String(payload.code).trim().toUpperCase();
    if (!code) throw new AppError(400, 'Material code is required.');

    const duplicate = await RawMaterial.findOne({ tenantId, code, _id: { $ne: material._id } });
    if (duplicate) throw new AppError(409, 'A raw material with this code already exists in this tenant.');
    material.code = code;
  }

  if (payload.name !== undefined) {
    const name = String(payload.name).trim();
    if (!name) throw new AppError(400, 'Material name is required.');
    material.name = name;
  }

  if (payload.unit !== undefined && payload.unit !== material.unit) {
    // Stock and ledger quantities are stored in the material's unit; changing it would silently rescale history.
    const hasHistory = material.currentStock > 0
      || await MaterialTransaction.exists({ tenantId, rawMaterialId: material._id });
    if (hasHistory) {
      throw new AppError(409, 'The unit cannot change after stock movements are recorded for this material.');
    }
    material.unit = payload.unit;
  }

  if (payload.minimumStock !== undefined) {
    material.minimumStock = Number(payload.minimumStock);
  }

  if (payload.isActive !== undefined) {
    material.isActive = Boolean(payload.isActive);
  }

  if (payload.currentStock !== undefined) {
    throw new AppError(400, 'Stock changes must be created through material transactions.');
  }

  await material.save();
  return material;
};

const deleteRawMaterialById = async (id, tenantId) => {
  const material = await RawMaterial.findOne({ _id: id, tenantId });

  if (!material) {
    return null;
  }

  material.isActive = false;
  await material.save();
  return material;
};

module.exports = {
  listRawMaterials,
  createRawMaterial,
  getRawMaterialById,
  updateRawMaterialById,
  deleteRawMaterialById,
};
