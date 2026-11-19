# amoCRM connector (ADR 081)

What it does: every new lead from the chats is created in your amoCRM (lead + contact name + phone) in the pipeline you choose, and when a manager moves the lead to another stage in amoCRM, it moves here too (stage sync, polled every 2 minutes, only the chosen pipeline).

## Connect (OWNER or ADMIN)
1. In amoCRM: Settings -> Integrations -> create a private integration -> Keys and access -> create a long-lived token (choose how long it lives; there is no refresh token).
2. Copy the account name from the address bar (`https://<name>.amocrm.ru`). Only `*.amocrm.ru` accounts are supported in this slice (not kommo.com).
3. tezda: Settings -> CRM -> amoCRM: enter the name and token, "Connect and check". The token is checked with `GET /api/v4/account`, stored encrypted and never shown again.
4. Choose the pipeline for new leads; open "Stage sync", review the mapping (142 -> Won, 143 -> Lost by default; other stages are ignored until chosen) and switch it on.

## Limits and behaviour
- At most 5 requests a second per account; 429 is retried with backoff; a 403 (account blocked after too many requests) pauses calls for 10 minutes and shows in the stage sync status.
- A token that expires or is revoked: the check fails with "token not accepted"; create a new token and use "Replace token".
- Disable keeps the credential; Disconnect deletes it. Leads kept locally while no CRM is connected are sent after connecting.
- Not verified on a live account yet (see ADR 081 implementation notes).
