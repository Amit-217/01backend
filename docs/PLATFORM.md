# Platform support operations

Open the web app at `/platform`. The console uses separate named staff accounts. The `support` role can inspect companies, users, stock, repair previews, and audit events. The `operator` role can also run the case-scoped actions below. Tenant admins open **Stock Activity → Transaction log** from their usual workspace.

## Provision staff access

1. Run the API against a MongoDB replica set or sharded cluster. Set `PLATFORM_TOTP_KEY` to a random 32-byte value encoded as base64 in the backend secret store. Keep a recoverable copy in the secret store. If the key is replaced, rotate staff credentials and authenticator seeds using the new key.
2. From a trusted interactive terminal in `Backend/`, set `PLATFORM_STAFF_PASSWORD` for the enrollment process. Use a unique password of at least 14 characters and at most 72 UTF-8 bytes. Run `node scripts/platform-staff.js enroll <email> <support|operator> <name>`. Use a secure channel to deliver the initial password and enroll the authenticator using the one-time setup key shown in the terminal. Clear the password from the parent shell environment after the command.
3. Sign in with the staff email, password, and a current six-digit authenticator code. Staff sessions expire after 30 minutes and the browser holds the session in memory. A successful code can be used once. Use HTTPS for staff access.
4. Use `node scripts/platform-staff.js rotate <email> <support|operator> <name>` with a new password to replace credentials or change the role. Use `node scripts/platform-staff.js disable <email>` to remove access. Both revoke existing platform sessions and leave an audit event. Enroll two named operators if the team needs to authorize repairs or recovery.

Generate an encryption key in a trusted terminal with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"` and transfer the output directly to the secret store. The authenticator uses SHA-1, six digits, a 30-second timestep, and one adjacent interval of clock tolerance. [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)

## Investigate and intervene

1. Open the exact company by ID or name. Verify the selected company and the target transaction or user. Use a case reference and a short reason for each action. Use references to link sensitive evidence held in the incident record.
2. Under **Stock**, open transaction details. A reversal appends an offsetting movement and returns the same reversal on retry. **Correct stock** posts a linked adjustment with an idempotency key. The tenant log shows `Viplora Support`, while the internal event identifies the individual staff member. A deduction needs adequate current stock.
3. Under **Finished Goods**, review balances and transaction details by product or SKU. Open a movement to reverse it or post a linked adjustment with the same case requirements. The tenant ledger shows `Viplora Support` and the internal audit identifies the staff member. These actions affect the selected finished SKU.
4. Under **Users**, suspend or reactivate an account, revoke its sessions, or send a reset code to the verified inbox of an active account. The user completes the existing reset flow. For company access, suspend or restore from the company header. Suspension invalidates sessions, and users sign in again after access is restored. Pending companies complete onboarding through the normal verification flow.
5. Review **Audit trail** for company-specific reads, changes, and failures. Use **Platform audit** for directory access, staff sign-in and sign-out, and staff provisioning events. The app exposes read access to audit events. Retain the audit collection and protect its write access with the deployment database role and backups.

## Bulk stock repairs

1. On **Repairs and recovery**, create a stock repair preview for 2–25 different materials. The preview records each current balance, unit, direction, and quantity.
2. A different operator reviews the saved preview and approves it within 24 hours. Approval applies all stock and audit effects in one transaction. A changed stock balance or unit rejects the whole batch. Create a fresh preview from the updated counts.
3. Inspect the completed request and transaction log. Record the case reference in any follow-up adjustment. Correct already-applied lines through the ledger.

## Backup-assisted data recovery

1. Identify the tenant, data scope, and verified backup. Restore the snapshot into a disposable isolated database using the storage provider's recovery process. Compare the staged records with current data and prepare the affected IDs, expected impact, checks, and rollback plan in the support case.
2. Create a **recovery preview** with the snapshot reference and impact summary. A different operator reviews the case and approves it within 24 hours. Before any production intervention, make a protected pre-change backup and agree on the maintenance window with the incident owner.
3. Execute the approved, tenant-scoped recovery through the deployment's recovery tooling. Reconcile stock through ledger entries so the balance and movement history stay consistent. Keep platform audit history and post-snapshot changes in the recovery plan.
4. Verify the recovered data and record the outcome and an evidence reference in the console. The platform app provides preview, approval, and outcome tracking. Backup restore execution is handled by your infrastructure tooling.

See the [API reference](API.md#platform-support) for endpoints and the [backend README](README.md#running-and-verifying) for test commands.
