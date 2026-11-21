# Payme payments

Not rehearsed against Payme; provider facts and URLs are from the official Payme Business documentation, read 2026-11-21 (ADR 084).

1. Before changing anything, confirm the Payme Business contract and cash desk exist, the account field is exactly `order_id`, active public UZS plan prices are correct, and a recent database backup is verified.
2. Put `PAYME_MERCHANT_ID`, `PAYME_LOGIN` and `PAYME_KEY` into the server secret store. Never paste or print them. Restart the API.
3. In the Payme Business cash desk set the Merchant API URL to `https://<api host>/api/v1/payments/payme`. If the edge uses an IP allowlist, copy the current addresses only from <https://developer.help.paycom.uz/protokol-merchant-api/skhema-vzaimodeystviya/>.
4. In sandbox (`https://test.paycom.uz`), run all cash-desk tests: authentication, unknown account, wrong amount, duplicate Create/Perform/Cancel, 12-hour timeout, cancel before Perform, refund after Perform, CheckTransaction and GetStatement.
5. Verify one fictional payment in Settings → Subscription: checkout amount equals the plan price in tiyin; Perform changes the payment to paid and extends once; repeated calls do not extend again; refund restores the previous entitlement. Logs may contain `payme.callback_failed` with method and error name only, never credentials or payloads.
6. Production checkout uses `https://checkout.paycom.uz`. Smoke test with an owner-approved small plan price only after sandbox certification; verify the Payme cabinet, `subscription_payments`, `payme_transactions`, the subscription period and platform audit event agree.

If callbacks fail, keep the cash desk in sandbox. `-32504` means Basic credentials are absent/wrong, `-31050` unknown `order_id`, `-31001` amount mismatch, `-31003` unknown Payme transaction and `-31008` the stored state forbids the operation. A generic `-32400` is also logged as `payme.callback_failed` without secret or request data.
