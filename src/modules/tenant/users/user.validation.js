const { z } = require('zod');
const { passwordSchema } = require('../auth/auth.validation');

// The password is optional: without one the employee is invited and sets it while verifying their email.
const employeeCreateValidation = z.object({
  firstName: z.string().trim().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().trim().optional().or(z.literal('')),
  email: z.string().trim().email('Enter a valid email'),
  password: passwordSchema.optional(),
  confirmPassword: z.string().optional(),
}).superRefine((data, ctx) => {
  if ((data.password || data.confirmPassword) && data.password !== data.confirmPassword) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmPassword'],
      message: 'Password confirmation does not match.',
    });
  }
});

module.exports = {
  employeeCreateValidation,
};
