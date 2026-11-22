# Backend API Reference

## Authentication

### Register tenant
- Method: POST
- Route: `/api/auth/register`
- Body:
  ```json
  {
    "name": "Acme Business",
    "email": "hello@acme.com"
  }
  ```
- Purpose: start company registration and send a company email verification OTP

### Verify tenant email
- Method: POST
- Route: `/api/auth/verify-email`
- Body:
  ```json
  {
    "email": "hello@acme.com",
    "otp": "123456"
  }
  ```
- Keep `data.onboardingToken` from the company verification response for the next signup steps.
- For employee verification, send `purpose: "employee_email_verification"` with the employee's email and OTP, plus `newPassword` and `confirmPassword`. The password is required for employees who were invited without one (`passwordSetupRequired`). It is optional otherwise and replaces the current password when sent. The code stays valid if the request fails only because the password is missing.

### Send admin email verification
- Method: POST
- Route: `/api/auth/send-admin-email-verification`
- Body:
  ```json
  {
    "email": "admin@acme.com",
    "companyEmail": "hello@acme.com",
    "onboardingToken": "<company verification token>"
  }
  ```

### Verify admin email
- Method: POST
- Route: `/api/auth/verify-admin-email`
- Body:
  ```json
  {
    "companyEmail": "hello@acme.com",
    "email": "admin@acme.com",
    "onboardingToken": "<company verification token>",
    "otp": "123456"
  }
  ```

### Register admin
- Method: POST
- Route: `/api/auth/register-admin`
- Body:
  ```json
  {
    "companyEmail": "hello@acme.com",
    "email": "admin@acme.com",
    "firstName": "Amit",
    "lastName": "Chandure",
    "password": "StrongPassword123",
    "confirmPassword": "StrongPassword123",
    "onboardingToken": "<company verification token>"
  }
  ```

### Finalize registration
- Method: POST
- Route: `/api/auth/finalize-registration`
- Alias for `/api/auth/register-admin`. Both routes activate the tenant and create the admin account.
- Body:
  ```json
  {
    "companyEmail": "hello@acme.com",
    "email": "admin@acme.com",
    "firstName": "Amit",
    "lastName": "Chandure",
    "password": "StrongPassword123",
    "confirmPassword": "StrongPassword123",
    "onboardingToken": "<company verification token>"
  }
  ```

### Login
- Method: POST
- Route: `/api/auth/login`
- Body:
  ```json
  {
    "email": "admin@acme.com",
    "password": "StrongPassword123"
  }
  ```

- **Per-account lock:** 10 failed sign-ins for the same account within 10 minutes lock it for 10 minutes, whichever devices or IP addresses send them. During the lock, every sign-in returns 429, even with the right password, with a message that says how many minutes remain and suggests a password reset. A successful sign-in, a completed password reset, or an employee setting their password clears the count and any lock. The per-IP rate limit still applies on top.

### Refresh token
- Method: POST
- Route: `/api/auth/refresh-token`
- Body:
  ```json
  {
    "refreshToken": "..."
  }
  ```
- Browser login and refresh requests send `X-Viplora-Client: web` and include cookies. The API returns the access token and user and rotates the HttpOnly refresh cookie. Native clients use the JSON refresh token.

### Logout
- Method: POST
- Route: `/api/auth/logout`
- Auth: required
- Web clients send `X-Viplora-Client: web` and include cookies. Logout revokes the current Bearer session.

### Forgot password
- Method: POST
- Route: `/api/auth/forgot-password`
- Body:
  ```json
  {
    "email": "admin@acme.com"
  }
  ```

### Verify reset OTP
- Method: POST
- Route: `/api/auth/verify-reset-otp`
- Body:
  ```json
  {
    "email": "admin@acme.com",
    "otp": "123456"
  }
  ```

### Reset password
- Method: POST
- Route: `/api/auth/reset-password`
- Body:
  ```json
  {
    "email": "admin@acme.com",
    "otp": "123456",
    "newPassword": "NewPass123",
    "confirmPassword": "NewPass123"
  }
  ```

### Resend OTP
- Method: POST
- Route: `/api/auth/resend-otp`
- Body:
  ```json
  {
    "email": "hello@acme.com",
    "purpose": "company_email_verification"
  }
  ```
- Supported purposes are `company_email_verification`, `employee_email_verification`, and `password_reset`. Use `/api/auth/send-admin-email-verification` with the onboarding token to resend an admin code.
- Codes have a 60-second resend cooldown per account. A company resend inside the cooldown returns 429. An employee or password-reset resend returns the usual generic message and reuses the live code, so the response does not reveal whether the account exists. `forgot-password` follows the same rule.
- After `verify-reset-otp` succeeds, the code stays valid for another full OTP window so the user can choose the new password.

### Password rule
- Every password a user chooses must be 8 characters to 72 bytes. bcrypt ignores bytes past 72, so the API rejects longer passwords instead of silently truncating them.

## Users

### Create employee
- Method: POST
- Route: `/api/users`
- Auth: required
- Admin required
- Body:
  ```json
  {
    "firstName": "Amit",
    "lastName": "Chandure",
    "email": "employee@acme.com"
  }
  ```
- Without `password`, the employee is **invited**. They receive a verification code and choose their own password through `/api/auth/verify-email`. The legacy `password` and `confirmPassword` fields still work.
- The response includes `emailSent`.
- Reusing the email of a deactivated employee in the same company returns 409 with a message to reactivate them instead.

### List users
- Method: GET
- Route: `/api/users?status=active|inactive`
- Auth: required
- Admin required
- Returns the current tenant's administrators and employees with the given status (default `active`), administrators first.

### Get user by ID
- Method: GET
- Route: `/api/users/:id`
- Auth: required
- Admin required
- Scope: current tenant only

### Update user
- Method: PATCH
- Route: `/api/users/:id`
- Auth: required
- Admin required
- Use the user's `userId` for `:id`.
- Reactivate an employee with `{ "status": "active" }`.
- Promote or demote with `{ "role": "admin" | "employee" }`.
- Rules:
  - Nobody can change their own role or status.
  - Only active employees with a verified email can be promoted.
  - Another administrator only accepts `{ "role": "employee" }`. Remove admin rights before any other change.
  - A role change signs that person out once.

### Deactivate user
- Method: DELETE
- Route: `/api/users/:id`
- Auth: required
- Admin required
- Employees only. Remove admin rights first.

## Company access (manual subscription billing)

Platform support sets each company to one of three access levels:

| Level | Sign in | Read | Change data |
|---|---|---|---|
| `full` | Yes | Yes | Yes |
| `read_only` | Yes | Yes | No. Every non-GET tenant request returns 403 with `details.code = "WORKSPACE_READ_ONLY"` and a message that includes the support contact. Exceptions: `POST /api/auth/logout`, `DELETE /api/users/:id`, and `PATCH /api/users/:id` with only `{ "status": "inactive" }` (deactivating someone who left) |
| `suspended` | No. Login returns 403 with a "paused" message and the support contact, and existing sessions end | No | No |

Read-only is enforced inside `authenticate`, so it covers every authenticated tenant route by default. Switching to read-only keeps sessions. Suspending revokes them. Password reset keeps working at every level. The support contact comes from `SUPPORT_NAME`, `SUPPORT_PHONE`, and `SUPPORT_EMAIL`.

## Tenant endpoints

### Current tenant
- Method: GET
- Route: `/api/tenants/me`
- Auth: required

Companies are created only through the verified signup flow under `/api/auth`.

## Raw material endpoints

Reads are available to admins and employees. Catalog writes (create, update, deactivate) require an admin.
Deactivation is a soft delete; send `{ "isActive": true }` in a PATCH to reactivate a category, material, or vendor.

### List raw material categories
- Method: GET
- Route: `/api/v1/raw-material-categories`
- Auth: required

### Create raw material category
- Method: POST
- Route: `/api/v1/raw-material-categories`
- Auth: admin
- Body:
  ```json
  {
    "name": "Chemicals"
  }
  ```

### Get raw material category by ID
- Method: GET
- Route: `/api/v1/raw-material-categories/:id`
- Auth: required

### Update raw material category
- Method: PATCH
- Route: `/api/v1/raw-material-categories/:id`
- Auth: admin
- Body: any of `name`, `isActive`

### Deactivate raw material category
- Method: DELETE
- Route: `/api/v1/raw-material-categories/:id`
- Auth: admin

### List raw materials
- Method: GET
- Route: `/api/v1/raw-materials`
- Auth: required

### Create raw material
- Method: POST
- Route: `/api/v1/raw-materials`
- Auth: admin
- The category must be active.
- Body:
  ```json
  {
    "code": "RM-001",
    "name": "Cotton Fiber",
    "categoryId": "66c2f2e2d9d87f1a12345678",
    "unit": "kg",
    "minimumStock": 50
  }
  ```

### Get raw material by ID
- Method: GET
- Route: `/api/v1/raw-materials/:id`
- Auth: required

### Update raw material
- Method: PATCH
- Route: `/api/v1/raw-materials/:id`
- Auth: admin
- Body fields are `code`, `name`, `categoryId`, `unit`, `minimumStock`, and `isActive`. The validator strips `currentStock`. Use the ledger API to change stock.
- Moving to a different category requires that category to be active.
- `unit` cannot change once the material has stock movements (409).

### Deactivate raw material
- Method: DELETE
- Route: `/api/v1/raw-materials/:id`
- Auth: admin

### List vendors
- Method: GET
- Route: `/api/v1/vendors`
- Auth: required

### Create vendor
- Method: POST
- Route: `/api/v1/vendors`
- Auth: admin
- Body:
  ```json
  {
    "name": "Apex Supply",
    "phone": "+91 9876543210",
    "email": "vendor@apex.com",
    "address": "Delhi, India",
    "gstin": "29ABCDE1234F1Z5"
  }
  ```

### Get vendor by ID
- Method: GET
- Route: `/api/v1/vendors/:id`
- Auth: required

### Update vendor
- Method: PATCH
- Route: `/api/v1/vendors/:id`
- Auth: admin
- Body: any of `name`, `phone`, `email`, `address`, `gstin`, `isActive`

### Deactivate vendor
- Method: DELETE
- Route: `/api/v1/vendors/:id`
- Auth: admin

### List material transactions
- Method: GET
- Route: `/api/v1/material-transactions`
- Auth: required
- Query accepts an optional `rawMaterialId`. A nonempty value must be a valid ObjectId. An empty value uses the unfiltered list.

### Create material transaction
- Method: POST
- Route: `/api/v1/material-transactions`
- Auth: required; `type: "ADJUSTMENT"` requires an admin
- The optional `Idempotency-Key` uses 1–128 of `A-Z a-z 0-9 . _ : -` and is scoped to the tenant and acting user. A retry with the same key and payload returns the original movement. A different payload with that key returns 409.
- Rules: `IN` uses direction `IN`; `CONSUMPTION` uses `OUT`; `ADJUSTMENT` may use either and requires a `reason`. `vendorId` and `rate` are accepted only on `IN`, and the vendor must be active. Stock cannot go below zero.
- Body:
  ```json
  {
    "rawMaterialId": "66c2f2e2d9d87f1a12345678",
    "type": "IN",
    "direction": "IN",
    "quantity": 25,
    "rate": 120,
    "vendorId": "66c2f2e2d9d87f1a12345679",
    "referenceType": "PURCHASE",
    "reason": "Monthly purchase",
    "notes": "Arrival from vendor"
  }
  ```

### Get material transaction by ID
- Method: GET
- Route: `/api/v1/material-transactions/:id`
- Auth: required

### Reverse a material transaction
- Method: POST
- Route: `/api/v1/material-transactions/:id/reverse`
- Auth: admin
- The API writes a linked adjustment and retains the original. Repeating the request returns the existing reversal. A reversal cannot be reversed.

Stock history is append-only: movements cannot be deleted. Use a reversal to correct a mistake.

### Tenant transaction audit

| Method | Route | Access |
|---|---|---|
| GET | `/api/v1/material-transactions/audit` | Tenant admin |
| GET | `/api/v1/material-transactions/audit/actors` | Tenant admin |
| GET | `/api/v1/material-transactions/audit/:id` | Tenant admin |

The list returns `{ items, nextCursor }`. Filters are `rawMaterialId`, `actorId`, `type`, and inclusive UTC `from` and `to` dates in `YYYY-MM-DD` form. Use `limit` from 1 to 50 (default 25) and pass the returned cursor with the same filters to load older entries. The actors endpoint returns `{ id, label }` entries for the company's existing movements.

Audit rows include the recorded actor and role when available, the movement and recording times, linked reversal and correction IDs, and stock before/after/unit on new entries. Older entries can omit the balance snapshot and use the actor's current name or stored ID as a fallback. Platform entries use actor ID `platform-support` and display name `Viplora Support`. Employees keep the existing ledger reads.

## Finished Goods

All endpoints use tenant authentication. Tenant admins manage the catalog. Employees can read active products and SKUs, record ordinary movements, and view tenant movement history.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/finished-goods/products` | List products |
| GET | `/api/v1/finished-goods/products/:id` | Read a product |
| POST | `/api/v1/finished-goods/products` | Create a product with `name` and `unit` |
| PATCH | `/api/v1/finished-goods/products/:id` | Rename, archive, or restore with `name` or `isActive` |
| GET | `/api/v1/finished-goods/skus` | List SKU balances, optionally filtered by `productId` |
| GET | `/api/v1/finished-goods/skus/:id` | Read a SKU |
| POST | `/api/v1/finished-goods/skus` | Create a SKU with `productId`, `code`, optional `size` and `colour` |
| PATCH | `/api/v1/finished-goods/skus/:id` | Update `code`, `size`, `colour`, or `isActive` |
| GET | `/api/v1/finished-goods/movements` | List ordinary finished-goods history |
| GET | `/api/v1/finished-goods/movements/:id` | Read ordinary movement details |
| GET | `/api/v1/finished-goods/movements/audit` | List detailed history as tenant admin |
| GET | `/api/v1/finished-goods/movements/audit/actors` | List actor IDs and labels as tenant admin |
| GET | `/api/v1/finished-goods/movements/audit/:id` | Read actor, balances, and links as tenant admin |
| POST | `/api/v1/finished-goods/movements` | Record a movement with an `Idempotency-Key` |
| POST | `/api/v1/finished-goods/movements/:id/reverse` | Append or retrieve a reversal as tenant admin. Supply `reason`. |

SKU codes are normalized to uppercase and unique within a company, including archived codes. Each SKU inherits the product unit. Product units and SKU parent products are fixed after creation. A SKU must have zero stock to be archived. Archive a product after archiving its active SKUs. Restore the product first when bringing a SKU back. Admin reads include archived catalog entries.

Send `skuId`, `type`, and `quantity` for a movement. Optional fields are `date` in `YYYY-MM-DD` UTC form, `reference`, and `notes`. Omit the date to record the current timestamp. `RECEIPT` and `RETURN` increase stock. `DISPATCH` decreases it. An admin can record `OPENING` with a reason before the first movement, or an `ADJUSTMENT` with `direction` and `reason`. Quantities range from 0.0001 to 1,000,000,000,000. Movement keys are scoped to tenant and actor, and conflicting reuse returns 409. Archive, opening-balance, and reversal conflicts also return 409. A stock decrease beyond the available balance returns 400.

History returns `{ items, nextCursor }` with optional `productId`, `skuId`, `type`, inclusive UTC `from` and `to` dates, `cursor`, and `limit` (1–50, default 25). Admin audit adds `actorId` and includes the recorded actor and before-and-after balances. Movement rows snapshot the product name, SKU code, variant, and unit so later catalog changes preserve historical labels. The finished-goods ledger is independent of raw-material consumption.

## Platform support

All paths below use the `/api/platform` prefix. Sign-in takes `{ email, password, code }` and returns `{ staff, token, expiresAt }`. Use the token as a Bearer credential on platform routes. Both staff roles can read and sign out. The `operator` role can submit the interventions in the second table.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` | Staff password and authenticator sign-in |
| POST | `/auth/logout` | Revoke the current staff session |
| GET | `/tenants` | List companies, optionally using `lookup` for exact ID or name |
| GET | `/audit` | Platform-wide activity outside a selected company |
| GET | `/tenants/:tenantId` | Company summary |
| GET | `/tenants/:tenantId/users` | List company users and their access status |
| GET | `/tenants/:tenantId/materials` | List materials and balances for repair selection |
| GET | `/tenants/:tenantId/stock` | Transaction log with tenant audit filters and pagination |
| GET | `/tenants/:tenantId/stock/actors` | List actors for the stock filter |
| GET | `/tenants/:tenantId/stock/:id` | Transaction audit detail |
| GET | `/tenants/:tenantId/finished-goods/products` | Finished product catalog |
| GET | `/tenants/:tenantId/finished-goods/skus` | Finished balances, optionally filtered by `productId` |
| GET | `/tenants/:tenantId/finished-goods/movements` | Finished-goods audit with the admin history filters |
| GET | `/tenants/:tenantId/finished-goods/movements/actors` | Actor options for finished-goods audit |
| GET | `/tenants/:tenantId/finished-goods/movements/:id` | Finished-goods movement detail |
| GET | `/tenants/:tenantId/audit` | Company-specific platform events |
| GET | `/tenants/:tenantId/changes` | Repair and recovery requests |

Company, user, audit, and change lists support `cursor` and return `{ items, nextCursor }`. User lists include inactive users. Material and actor options are arrays.

All interventions are POST requests under `/tenants/:tenantId`. Include `caseReference` and `reason` in every body.

| Path suffix | Additional input and effect |
|---|---|
| `/stock/:id/reverse` | Append or retrieve the linked reversal |
| `/stock/adjustment` | Supply `rawMaterialId`, `correctionOf`, `direction`, `quantity`, and the `Idempotency-Key` header |
| `/finished-goods/movements/:id/reverse` | Append or retrieve a finished-goods reversal |
| `/finished-goods/movements/adjustment` | Supply `skuId`, matching `correctionOf`, `direction`, `quantity`, and the `Idempotency-Key` header |
| `/access` | Set `access` to `full`, `read_only`, or `suspended` (manual subscription control). Suspended revokes all company sessions |
| `/billing` | Set `paidUntil` (`YYYY-MM-DD` or `null`) and an optional `billingNote` (up to 500 characters). Internal to staff. The console flags the company as Overdue after the date. Access never changes automatically |
| `/status` | Older endpoint: set workspace `status` to `inactive` or `active`. Prefer `/access` |
| `/users/:userId/status` | Set user `status` to `inactive` or `active` |
| `/users/:userId/role` | Set user `role` to `admin` or `employee` (restores admin access for a locked-out company). Promoting needs an active user with a verified email. Removing the last active administrator returns 409. Revokes that user's sessions |
| `/users/:userId/revoke-sessions` | Invalidate all sessions for the selected user |
| `/users/:userId/request-recovery` | Send a password-reset code to the existing verified inbox |
| `/changes/stock` | Preview 2–25 `lines` with distinct `rawMaterialId`, `direction`, and `quantity` |
| `/changes/recovery` | Save the staged `snapshotReference` and `impactPreview` |
| `/changes/:id/approve` | Approve a pending preview as a different operator. Stock approval applies the batch. |
| `/changes/:id/complete` | Record approved recovery `outcome` (`completed` or `failed`) with `evidenceReference` |

Invalid inputs return 400, unauthorized staff actions return 403, targets outside the selected company return 404, and stale repair previews return 409. See [platform support operations](PLATFORM.md) for provisioning and the backup recovery runbook.

## Security conventions
- OTPs are purpose-specific
- Email addresses are normalized to lowercase
- Password hashes are created before storage
- Refresh tokens are hashed and rotated
- Access tokens are short-lived
- Admin routes require the `admin` role
- Tenant IDs are fetched from the authenticated user context rather than request body
- Raw material stock changes must be performed only through material transaction APIs to keep inventory history reliable

## Swagger
The application serves Swagger UI at `/api-docs`. Check [app.js](../src/app.js) and the mounted routers for active endpoints.
