# Viplora SaaS Backend

## Overview
This backend is the tenant-first SaaS foundation for Viplora. The current V1 scope includes tenant setup, tenant user management, email verification, login, JWT access/refresh tokens, admin authorization, password reset, and tenant isolation.

## Architecture

### Core folders
- `src/app.js` - Express app bootstrap and route mounting
- `src/server.js` - server entrypoint and database initialization
- `src/config/` - environment and external service configuration
- `src/common/` - reusable utilities, middleware, and shared models
- `src/modules/tenant/` - tenant-specific auth, tenant, and users modules
- `src/modules/raw_material/` - categories, raw materials, vendors, and the stock ledger
- `src/modules/finished_goods/` - products, SKUs, and the finished-goods ledger
- `src/modules/platform/` - staff sign-in, scoped support operations, repair approvals, and platform audit

### Security model
- Platform and tenant domains are separated by module structure
- Tenant users are stored under the tenant users module only
- Admin and employee roles are limited to `admin` and `employee`
- JWT access tokens are short-lived and stored in the Authorization header as Bearer token
- Refresh tokens are opaque, rotated independently per device or browser, and stored as hashes in the auth session collection
- Native clients receive refresh tokens in JSON. Web sign-in uses an HttpOnly refresh cookie and a Bearer access token.
- OTPs are purpose-specific and cleared after successful verification

## Validation
Routes use the [shared Zod middleware](../src/common/middlewares/validate.js) for request bodies. Each route imports its active schemas from the feature's validation file. The middleware replaces the request body with the parsed data. Services enforce business rules and validate inputs such as the ledger's `rawMaterialId` query filter.

## Auth flow
### Tenant registration
1. POST `/api/auth/register`
2. Company email is validated and normalized
3. A secure OTP is created for company email verification
4. The OTP is emailed to the company email
5. POST `/api/auth/verify-email` confirms the OTP

### Admin creation
1. Company email is verified
2. Admin email verification may be triggered if the admin email differs from the company email
3. Final admin account creation is completed with password and confirmPassword checks

### Login
- POST `/api/auth/login`
- Shared user login endpoint for both admin and employee
- Default access token expiry is 15 minutes. Configure it with `ACCESS_TOKEN_EXPIRY`.
- Refresh token expiry: 7 days

### Password reset
- POST `/api/auth/forgot-password`
- POST `/api/auth/verify-reset-otp`
- POST `/api/auth/reset-password`

## User management
- Admin-only employee creation: POST `/api/users`
- Tenant-scoped listing of active employees: GET `/api/users`
- Tenant-scoped user lookup: GET `/api/users/:id`
- Admin-only updates and deactivation: PATCH/DELETE on user resource

## Tenant isolation
Requests are expected to use the authenticated user context instead of trusting `req.body`, `req.query`, or `req.params` tenant IDs.

This keeps tenant A and tenant B users fully separated.

## Current status
The tenant and inventory APIs support Viplora's Android and browser clients. Both roles can read inventory and record receipts and consumption. Admins can manage catalogs and employees, post stock adjustments, and reverse movements.

Stock changes and ledger entries commit in a single MongoDB transaction. Use a replica set or sharded cluster for stock writes and company signup finalization. Clients can supply an `Idempotency-Key` for a safe stock retry. The reversal endpoint records a linked adjustment and preserves the original movement. See the [API reference](API.md) for routes and request fields.

## Running and verifying

Copy `.env.example` to `.env`, configure your database and SMTP, and run `npm.cmd start`. Browser deployments should share an HTTPS origin with the API. Set `WEB_ORIGINS` to an explicit origin when using a same-site browser origin on a separate host or port. Set `JWT_ACCESS_SECRET` for production. Check existing user data for duplicate normalized emails before the first startup on this version. Previously issued credentials are replaced when users sign in again.

Run `npm.cmd test` for the default suite. Set `TEST_MONGO_URI` to a disposable replica set to also exercise signup, session rotation, and inventory transactions with MongoDB. Integration tests create and drop uniquely named databases.

The same integration run covers tenant audit visibility, staff TOTP sign-in, support permissions, stock repair rollback, and account and tenant suspension. Platform support setup and the recovery workflow are in [PLATFORM.md](PLATFORM.md).

Finished-goods integration verifies tenant catalog permissions, normalized SKU uniqueness, independent balances, retry-safe stock writes, rollback, and case-linked support interventions. See the [Finished Goods API](API.md#finished-goods).
