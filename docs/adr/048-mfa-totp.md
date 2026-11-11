# ADR 048 — Multi-factor authentication (TOTP) for platform admins and tenant operators

Status: accepted (owner approved code changes for the audit roadmap, 2026-11-11). Roadmap item P0.2; finding SEC-02 in `docs/audit/2026-11-10/AGENTCORE_SECURITY_AND_PRODUCTION_REVIEW.md`. Builds on ADR 020/021 (tenant sessions, login limits) and ADR 047 (platform sessions).

## Context
Both principal types (tenant `Operator` with `OperatorCredential`, and `PlatformAdmin`) sign in with e-mail and password only. A stolen password of a platform owner exposes every tenant; of a tenant OWNER, the whole tenant. The project rule is no new dependencies in this phase.

## Decision
1. **TOTP per RFC 6238** (HMAC-SHA1, 6 digits, 30 s step, accept the previous, current and next step) implemented with `node:crypto`; secrets are 20 random bytes shown as base32. Codes are compared in constant time. **Replay protection:** the last accepted step is stored; a code for a step ≤ the stored one is refused.
2. **Secret storage:** sealed with the existing keyring (`SECRETS_MASTER_KEY`, `SECRETS_KEY_ID`, AES-256-GCM, `secrets/secret-cipher.ts`): columns `totp_key_id`, `totp_nonce`, `totp_ciphertext`, `totp_enabled_at`, `totp_last_step` on `operator_credentials` and on `platform_admins`. A pending (not yet confirmed) secret is stored in the same columns with `totp_enabled_at = null`. Without the keyring, enrolment is refused (`MFA_NOT_AVAILABLE`), never stored in clear.
3. **Recovery codes:** 10 single-use codes of 10 base32 characters, shown once at enable/regenerate, stored as HMAC-SHA256 hashes (`mfa_recovery_hashes text[]`); use removes the hash atomically (conditional update), and is audited.
4. **Login is two steps when MFA is on:** `POST …/login` with a correct password and MFA enabled returns `200 { mfaRequired: true, challenge }` and **no session**; `POST …/login/mfa { challenge, code | recoveryCode }` creates the session exactly as today. The challenge is a random token stored hashed in `mfa_challenges` (principal type, principal id, tenant id for operators, expiry 5 min, attempts ≤ 5, consumed at). Wrong codes count toward the existing per-account lockout and login limiter.
5. **Enforcement:** platform admins **must** use MFA: a platform login with a correct password and no MFA returns `{ mfaEnrollmentRequired: true, challenge }`; the challenge allows only setup and enable, after which the session is created. Tenant operators: optional now; the Security page recommends it to OWNER/ADMIN; a tenant setting to require it is a later step.
6. **Endpoints** (both principal types, own guards): `GET …/mfa` status; `POST …/mfa/setup` → `{ secret, otpauthUri }` (`otpauth://totp/tezda:<email>?secret=…&issuer=tezda`); `POST …/mfa/enable { code }` → recovery codes once; `POST …/mfa/disable { password, code }` (platform admins cannot disable while enforcement is on); `POST …/mfa/recovery-codes { code }` regenerate. All writes audited (`audit_events` / `platform_audit_events`), no secret or code ever logged.
7. **UI:** two-step login forms (tenant `/login`, console `/console/login`), a Security section (tenant Settings, console) for setup with the secret and URI as copyable text. **No QR image** in this step (it would need a new dependency); authenticator apps accept manual keys.

## Consequences
- Migration is additive (nullable columns, one table). Existing users are unaffected until they enrol; the platform owner is asked to enrol at the next console login.
- Lost authenticator + lost recovery codes: a platform owner resets another admin's MFA (audited); for the last platform owner the reset is the CLI on the server (`ops:platform-admin-reset-mfa --email …`, now implemented; it also revokes that admin's sessions and is audited with `via: server_cli`).
- Two extra round trips only for users with MFA.

## Verification
Unit: RFC 6238 test vectors (Appendix B, SHA-1), window and replay, base32, recovery code hashing. Integration (real DB): enable/disable, two-step login for both principal types, replay refused, challenge expiry and attempt limit, recovery code single use, platform enforcement, lockout interaction. e2e: enrol from the Security page, log out, log in with a code computed in the test from the shown secret; console forced enrolment.
