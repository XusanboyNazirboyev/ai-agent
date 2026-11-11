# Platform console — operator guide (ADR 047)

The console is where tezda staff open an account for each customer business,
watch its usage and control its subscription. It lives in the same web app
under `/console`, with its **own** sign-in and cookies (`ac_platform`,
`ac_platform_csrf`); a customer's login never opens it and a console login
never opens a customer's inbox.

Roles: **Platform owner** can do everything; **Support** sees every screen
read-only (write buttons are hidden and the API refuses writes with 403).

## 1. Bootstrap the first platform owner (once per server)

On the server (or locally against your database), from `apps/api`:

```sh
pnpm ops:platform-admin --email you@example.com --name "Your Name" \
  --password-file /secure/path/platform-owner.txt
```

The random password is written to that file (mode 0600, must not exist yet)
and is never printed. Sign in at `/console/login`, then delete the file.

**First sign-in asks for two-step verification (ADR 048).** After the password the
console shows a setup key (and otpauth link): add it to an authenticator app,
enter the 6-digit code, and save the 10 recovery codes shown once. Every later
sign-in needs a code (or one recovery code, single use). Requires
`SECRETS_MASTER_KEY` on the server; without it console sign-in is refused. If an
admin loses both, another owner resets it (audited; API `POST /api/v1/platform/admins/:id/mfa/reset`, no button yet) and the admin
enrols again.
Further admins are invited from **Console → Admins** (owner only): the
invite link is shown once; the person sets their own password at
`/console/invite/…`. The last active owner cannot be deactivated.

## 2. Plans

**Console → Plans → New plan**: code (fixed later), name, price typed in
major units (for example `150 000` som; it is stored in minor units),
currency (fixed later), period in days, optional limits (operators,
messenger accounts). Prices are your decision; nothing is seeded. A plan is
never deleted: "Stop offering" hides it from new subscriptions, customers
already on it keep it.

## 3. Create a customer and hand over the invite

**Console → Customers → New customer**: business name, short name (slug),
owner's e-mail, business type (Domain Pack), main language, time zone and
optionally a plan (with trial days for a trial, or empty for a paid period).
The result shows the owner's **invite link once**: copy it and send it to
the owner directly (messenger, e-mail). It works for 72 hours. You never see
or set the owner's password.

If the link is lost or expired, open the customer and use **Team and
invitations → Invite** to create a new one (the old one for the same
e-mail stops working).

## 4. Record a payment

Open the customer → **Payments → Record payment**: amount as on the receipt,
currency, optional bank/cash reference (a reference can be recorded only
once) and note. Leave **Extend the subscription by one plan period** on to
move the period end forward. Without an open subscription, start one first
in the **Subscription** card (start, change plan, extend, cancel; each asks
for confirmation, cancel asks for a reason).

## 5. Suspend, reactivate, archive

Open the customer → **Suspend** (a reason is required and goes to the audit
log). Everyone in that workspace is signed out at once, nobody can sign in
(they see "This workspace is suspended. Please contact tezda support.") and
the assistant stops; new messenger messages are refused. **Reactivate**
restores access. **Archive** is the same for a customer who has left; no
data is deleted.

## 6. What the customer sees

- **Expired or canceled subscription:** the team still signs in; a red
  banner says the subscription has ended and the assistant is paused, and
  that they can still answer customers by hand. Incoming messages are
  stored, the bot does not answer, and the inbox shows a notice.
- **Payment overdue (grace period):** a yellow banner names the date when
  the assistant will pause.
- **Settings → Subscription** (owner/admin): plan, price per period, status,
  period end, grace date and payment history, read-only.
- **Settings → Team** (owner/admin): invite colleagues with a role, change
  roles, deactivate/reactivate, revoke invitations. The plan's operator
  limit, "an admin cannot grant Owner" and "the last owner stays" are
  enforced by the API and explained on screen.

## 7. Audit

**Console → Audit log** lists every console write (who, what, which
customer, safe summary such as the reason), newest first.

## Not yet built

Click payments (blocked on the merchant credentials, ADR 047 §6), self-serve
signup, invoices. Wording in Uzbek and Russian has not been reviewed by a
native speaker.
