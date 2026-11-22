# Tenant, admin, and employee flow

Start with the [auth routes](../src/modules/tenant/auth/auth.route.js) and [user routes](../src/modules/tenant/users/user.route.js). The signup, session, and employee rules live in [onboarding.service.js](../src/modules/tenant/auth/onboarding.service.js), [auth.service.js](../src/modules/tenant/auth/auth.service.js), [session.service.js](../src/modules/tenant/auth/session.service.js), and [user.service.js](../src/modules/tenant/users/user.service.js).

---

## 1) Tenant registration

### Step 1: Register tenant/company
Endpoint:
```http
POST /api/auth/register
```

Body:
```json
{
  "name": "Acme Business",
  "email": "hello@acme.com"
}
```

What happens:
- creates tenant record
- sends OTP to company email
- returns message to verify company email

---

## 2) Verify company email
Endpoint:
```http
POST /api/auth/verify-email
```

Body:
```json
{
  "email": "hello@acme.com",
  "otp": "123456"
}
```

The response includes `data.onboardingToken`. Keep it for admin setup. The company becomes active at finalization.

---

## 3) Admin registration flow

There are 2 cases.

### Case A: Admin email is the same as company email
Example:
- company email = `hello@acme.com`
- admin email = `hello@acme.com`

Then no separate admin OTP step is required.

You can directly call:
```http
POST /api/auth/register-admin
```

Body:
```json
{
  "companyEmail": "hello@acme.com",
  "email": "hello@acme.com",
  "onboardingToken": "<company verification token>",
  "firstName": "Amit",
  "lastName": "Chandure",
  "password": "StrongPassword123",
  "confirmPassword": "StrongPassword123"
}
```

Important rule from code:
- if admin email equals company email, it skips the extra admin-email verification requirement
- this is enforced in the service logic

After this:
- tenant is finalized
- admin user is created with role `admin`
- admin email is considered verified automatically for same-email case

---

### Case B: Admin email is different from company email
Example:
- company email = `hello@acme.com`
- admin email = `admin@acme.com`

Then flow is:

#### Step 3.1: Send admin OTP
```http
POST /api/auth/send-admin-email-verification
```

Body:
```json
{
  "companyEmail": "hello@acme.com",
  "email": "admin@acme.com",
  "onboardingToken": "<company verification token>"
}
```

This:
- finds tenant by company email
- stores admin email
- sends OTP to admin email

#### Step 3.2: Verify admin OTP
```http
POST /api/auth/verify-admin-email
```

Body:
```json
{
  "companyEmail": "hello@acme.com",
  "email": "admin@acme.com",
  "onboardingToken": "<company verification token>",
  "otp": "123456"
}
```

This sets:
- `tenant.adminEmailVerified = true`

#### Step 3.3: Create admin user
```http
POST /api/auth/register-admin
```

Body:
```json
{
  "companyEmail": "hello@acme.com",
  "email": "admin@acme.com",
  "onboardingToken": "<company verification token>",
  "firstName": "Amit",
  "lastName": "Chandure",
  "password": "StrongPassword123",
  "confirmPassword": "StrongPassword123"
}
```

This creates the admin user and completes tenant setup.

> If admin email is different, the code requires admin email verification before finishing registration.

---

## 4) Login after admin creation
Endpoint:
```http
POST /api/auth/login
```

Body:
```json
{
  "email": "admin@acme.com",
  "password": "StrongPassword123"
}
```

This returns:
- accessToken
- user info

Native clients also receive a JSON refresh token. Browsers send `X-Viplora-Client: web` and receive the refresh token as an HttpOnly cookie. See the [API reference](API.md#refresh-token) for refresh requests.

---

## 5) Employee flow

After admin login, an admin can invite employees, share admin rights, and deactivate or reactivate employees. Team reads are admin-only. A company should keep at least two administrators so access survives one person leaving. If a company loses all its administrators, platform support can restore one with `/users/:userId/role`, subject to the case-reference and audit rules in [PLATFORM.md](PLATFORM.md).

### Step 5.1: Invite employee
Endpoint:
```http
POST /api/users
```

Header:
```http
Authorization: Bearer <admin-access-token>
```

Body:
```json
{
  "firstName": "Rahul",
  "lastName": "Patil",
  "email": "employee@acme.com"
}
```

What happens:
- employee record is created with a random unusable password and `passwordSetupRequired = true`
- employee email is set to unverified
- OTP is generated and sent to the employee email (`otpPurpose = "employee_email_verification"`)
- the admin never learns the employee's password, so "Recorded by" in the transaction log identifies the employee

Sending `password` and `confirmPassword` still works for older clients. This is in `user.service.js`.

---

### Step 5.2: Verify employee email
Endpoint:
```http
POST /api/auth/verify-email
```

Body:
```json
{
  "email": "employee@acme.com",
  "otp": "123456",
  "purpose": "employee_email_verification",
  "newPassword": "ChosenByEmployee123",
  "confirmPassword": "ChosenByEmployee123"
}
```

This sets:
- `user.emailVerified = true`
- the employee's chosen password, which clears `passwordSetupRequired` and revokes any older sessions

A missing password for an invited employee returns 400 and leaves the code valid. Only after verification can the employee log in.

### Step 5.3: Deactivate, reactivate, and roles
- `DELETE /api/users/:id` deactivates an employee and revokes their sessions. `GET /api/users?status=inactive` lists deactivated people. `PATCH /api/users/:id` with `{ "status": "active" }` restores them.
- `PATCH /api/users/:id` with `{ "role": "admin" }` promotes an active, verified employee. `{ "role": "employee" }` removes another admin's rights. Nobody changes their own role or status.

---

## 6) Minimum flow summary

### Same admin email
1. `POST /api/auth/register`
2. `POST /api/auth/verify-email`
3. `POST /api/auth/register-admin`
4. `POST /api/auth/login`
5. `POST /api/users`
6. `POST /api/auth/verify-email` with employee purpose

### Different admin email
1. `POST /api/auth/register`
2. `POST /api/auth/verify-email`
3. `POST /api/auth/send-admin-email-verification`
4. `POST /api/auth/verify-admin-email`
5. `POST /api/auth/register-admin`
6. `POST /api/auth/login`
7. `POST /api/users`
8. `POST /api/auth/verify-email` with employee purpose

---

## 7) One important rule in code

The service checks this condition:

- if admin email is different from company email, admin verification is mandatory
- if admin email is the same as company email, it skips the extra verification

That is why the “same email” flow is shorter than the “different email” flow.

## Workspace access and platform staff

Tenant sign-in, session refresh, and protected requests require an active company. Company suspension revokes current sessions. After restoration, users sign in again with their own credentials. Existing active company sessions use access version zero until the first status change.

Platform staff sign in with their own password and authenticator on `/platform`. The console can send the tenant's existing reset code to a verified inbox and records that intervention internally. See [platform support operations](PLATFORM.md).
