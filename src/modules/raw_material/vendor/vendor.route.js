const express = require('express');
const authenticate = require('../../../common/middlewares/authenticate');
const authorizeAdmin = require('../../../common/middlewares/authorizeAdmin');
const validate = require('../../../common/middlewares/validate');
const {
  createVendor,
  listVendor,
  getVendor,
  updateVendor,
  deleteVendor,
} = require('./vendor.controller');
const {
  createVendorValidation,
  updateVendorValidation,
} = require('./vendor.validation');

const router = express.Router();

router.use(authenticate);
router.get('/', listVendor);
router.post('/', authorizeAdmin, validate(createVendorValidation), createVendor);
router.get('/:id', getVendor);
router.patch('/:id', authorizeAdmin, validate(updateVendorValidation), updateVendor);
router.delete('/:id', authorizeAdmin, deleteVendor);

module.exports = router;
