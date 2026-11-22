const express = require('express');
const { z } = require('zod');
const { createUser, listUsers, getUserById, updateUser, deleteUser } = require('./user.controller');
const { employeeCreateValidation } = require('./user.validation');
const authenticate = require('../../../common/middlewares/authenticate');
const authorizeAdmin = require('../../../common/middlewares/authorizeAdmin');
const validate = require('../../../common/middlewares/validate');

const router = express.Router();
const employeeFields = employeeCreateValidation.shape;
const employeeUpdateValidation = z.object({
  firstName: employeeFields.firstName.optional(),
  lastName: employeeFields.lastName,
  email: employeeFields.email.optional(),
  password: employeeFields.password,
  confirmPassword: employeeFields.confirmPassword,
  status: z.enum(['active', 'inactive']).optional(),
  role: z.enum(['admin', 'employee']).optional(),
}).refine(({ password, confirmPassword }) => password === confirmPassword, {
  message: 'Password confirmation does not match.',
  path: ['confirmPassword'],
});

// Team management is admin-only, including reads: employees must not list colleagues' contact details.
router.post('/', authenticate, authorizeAdmin, validate(employeeCreateValidation), createUser);
router.get('/', authenticate, authorizeAdmin, listUsers);
router.get('/:id', authenticate, authorizeAdmin, getUserById);
router.patch('/:id', authenticate, authorizeAdmin, validate(employeeUpdateValidation), updateUser);
router.delete('/:id', authenticate, authorizeAdmin, deleteUser);

module.exports = router;
