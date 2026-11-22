const express = require('express');
const authenticate = require('../../../common/middlewares/authenticate');
const authorizeAdmin = require('../../../common/middlewares/authorizeAdmin');
const validate = require('../../../common/middlewares/validate');
const {
  createCategory,
  listCategory,
  getCategory,
  updateCategory,
  deleteCategory,
} = require('./category.controller');
const {
  createCategoryValidation,
  updateCategoryValidation,
} = require('./category.validation');

const router = express.Router();

router.use(authenticate);
router.get('/', listCategory);
router.post('/', authorizeAdmin, validate(createCategoryValidation), createCategory);
router.get('/:id', getCategory);
router.patch('/:id', authorizeAdmin, validate(updateCategoryValidation), updateCategory);
router.delete('/:id', authorizeAdmin, deleteCategory);

module.exports = router;
