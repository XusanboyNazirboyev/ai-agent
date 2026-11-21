# ADR 084 — Subscription payments through Payme

Status: accepted (2026-11-21). Owner decision: offer Payme alongside Click. The existing manual renewal, Click flow and the decision not to store cards or charge automatically remain unchanged.

## Facts checked

Official Payme Business documentation, read 2026-11-21:

- Merchant API is JSON-RPC 2.0 over HTTPS `POST`. RPC answers use HTTP 200; authentication is HTTP Basic with the login supplied by Payme and the cash-desk key. Payme publishes the source IP addresses merchants may allow. <https://developer.help.paycom.uz/protokol-merchant-api/> and <https://developer.help.paycom.uz/protokol-merchant-api/skhema-vzaimodeystviya/>
- Checkout GET initialization is `https://checkout.paycom.uz/base64(params)`. Parameters are semicolon-separated: `m` merchant id or alias, `ac.<field>` account, `a` amount in tiyin, `l` language, `c` return URL, and optional timeout/return behavior. Sandbox checkout is `https://test.paycom.uz`. <https://developer.help.paycom.uz/initsializatsiya-platezhey/otpravka-cheka-po-metodu-get/> and <https://developer.help.paycom.uz/pesochnitsa/>
- Required Merchant API methods are `CheckPerformTransaction`, `CreateTransaction`, `PerformTransaction`, `CancelTransaction`, `CheckTransaction` and `GetStatement`. Duplicate Create/Perform/Cancel calls must return the stored outcome. <https://developer.help.paycom.uz/metody-merchant-api/>
- A created transaction times out after 43,200,000 ms (12 hours), becoming state `-1`, reason `4`. States are `1` created, `2` performed, `-1` cancelled before perform and `-2` cancelled/refunded after perform. <https://developer.help.paycom.uz/metody-merchant-api/createtransaction/> and <https://developer.help.paycom.uz/metody-merchant-api/tipy-dannykh/>
- Merchant error codes used here are `-31001` wrong amount, `-31003` unknown transaction, `-31008` operation unavailable and `-31050` unknown account; protocol errors are `-32400`, `-32504`, `-32600`, `-32601` and `-32700`. Error messages are a `ru`/`uz`/`en` object. <https://developer.help.paycom.uz/metody-merchant-api/oshibki-errors/>, <https://developer.help.paycom.uz/protokol-merchant-api/obschie-oshibki/> and <https://developer.help.paycom.uz/protokol-merchant-api/format-otveta/>

Not verified against Payme sandbox or a live cash desk: credentials, source IPs, cabinet configuration and the exact sandbox certification result. An owner merchant account is required.

## Decision

- Settings → Subscription offers a separate “Pay with Payme” button when all three Payme settings exist. `POST /api/v1/billing/payme/checkout { planCode, locale }` creates or reuses a one-hour `PAYME` pending payment. The server chooses the amount from the active public UZS plan and builds `ac.order_id=<payment UUID>`; the browser cannot supply an amount or tenant.
- Payme calls one public endpoint: `POST /api/v1/payments/payme`. It has no operator session or CSRF cookie. The complete Basic credential is compared in constant time and is never logged. Malformed JSON returns JSON-RPC `-32700`; every RPC result, including errors, returns HTTP 200.
- The six required methods are implemented. Create stores Payme's 24-character id, Payme time, amount and our payment UUID. Perform atomically wins `PENDING -> PAID`, applies the plan once and stores a safe entitlement snapshot. GetStatement reads transactions across the one merchant account on the privileged connection and returns them by Payme time. All order work after routing runs inside the payment tenant's RLS context.
- Cancel before Perform marks the payment failed. Cancel after Perform marks it refunded and reverses exactly that entitlement: it restores the prior subscription when it was the latest payment, or subtracts only its period when a later paid extension exists. It never stores or logs raw Payme payloads.
- Storage is additive: `PaymentProvider.PAYME` and tenant-owned `payme_transactions` with RLS, a unique Payme id, one transaction per payment, provider times/states/reason and the code-owned entitlement snapshot. The migration is `20261130120000_payme_transactions`.
- Secrets are `PAYME_MERCHANT_ID`, `PAYME_LOGIN` and `PAYME_KEY` in the server secret store. `order_id` is the cash-desk account field configured in Payme Business.

## Owner steps

1. Sign the Payme Business contract and create a cash desk whose account field is exactly `order_id`.
2. Put the three `PAYME_*` values into the server secret store; never paste them into chat or git.
3. Set the Merchant API URL to `https://<api host>/api/v1/payments/payme` and, if used, allow only Payme's currently documented source IP addresses at the edge.
4. Run every Payme sandbox test, including duplicate calls, wrong account/amount, timeout, cancel before Perform and refund after Perform. Only then switch the checkout from the sandbox to production credentials.

## Not done

Card storage, recurring/automatic charging, provider-specific refund UI, fiscal receipt data (`SetFiscalData`) and live/sandbox verification. Payme cancellation/refund callbacks themselves are implemented because Merchant API certification requires them.
