const express = require('express');
const authenticate = require('../../../common/middlewares/authenticate');
const authorizeAdmin = require('../../../common/middlewares/authorizeAdmin');
const validate = require('../../../common/middlewares/validate');
const {
  createMaterial,
  listMaterials,
  getMaterial,
  updateMaterial,
  deleteMaterial,
} = require('./raw.material.controller');
const {
  createRawMaterialValidation,
  updateRawMaterialValidation,
} = require('./raw.material.validation');

const router = express.Router();

router.use(authenticate);
router.get('/', listMaterials);
router.post('/', authorizeAdmin, validate(createRawMaterialValidation), createMaterial);
router.get('/:id', getMaterial);
router.patch('/:id', authorizeAdmin, validate(updateRawMaterialValidation), updateMaterial);
router.delete('/:id', authorizeAdmin, deleteMaterial);

module.exports = router;
