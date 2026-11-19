# 08 Click payments setup (ADR 082)

Not rehearsed against Click; values and screens are from docs.click.uz (read 2026-11-19).

1. Sign the Click merchant contract and open the merchant cabinet.
2. Put `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` (optional `CLICK_MERCHANT_USER_ID`) into the server's secret store. Never paste them into chat, logs or git. Restart the API.
3. In the cabinet set the service's Prepare URL to `https://<api host>/api/v1/payments/click/prepare` and the Complete URL to `https://<api host>/api/v1/payments/click/complete`.
4. In the console enter plan prices in UZS and mark plans public.
5. Check: Settings -> Subscription shows "Pay with Click" (hidden when any of the three values is missing). Pay a small amount with a test plan; the payment row turns Paid and the period end moves once.
6. If a callback fails: API logs carry `click.callback` with the error code only. -1 sign (wrong secret), -8 wrong service id or missing fields, -2 amount differs from the plan price, -5 unknown order. Repeated error answers can send the payment to Click support review.
