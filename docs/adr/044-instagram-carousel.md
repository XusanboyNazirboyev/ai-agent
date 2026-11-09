# ADR 044: Instagram carousel of catalog items, with postback buttons

- **Status:** Accepted (owner decision 2026-11-09: add `image_url` to the catalog/CRM model and postback handlers; "CRM'da rasmlar qo'llab-quvvatlanadi"). Implemented 2026-11-09 (owner approved the `messaging_postbacks` subscription the same day); live check with an app-role account still pending.
- **Context:** the owner audit v2 asks for carousels in Instagram Direct. The canonical `CatalogItem` (D9) has no image, and nothing handles a button tap.

## Facts from Meta docs (read 2026-11-09)
Source: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template.md
- `POST https://graph.instagram.com/<IG_ID>/messages` (sample: `/v20.0/me/messages`), `recipient.id` = Instagram-scoped id. Body: `message.attachment.type = "template"` and `payload.template_type = "generic"`, with `payload.elements[]`.
- Limits: at most 10 elements; `title` and `subtitle` 80 characters each; at most 3 buttons per element; only `postback` and `web_url` buttons; `image_url` optional (no size or format rules stated).
- "Currently not available on desktop."
- Postback tap (https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md): `messaging[].postback { mid, title, payload }` with `sender.id` and `recipient.id`. The `messaging_postbacks` event must be subscribed.
- Not stated on the pages read: a payload length limit, and whether the Unified-login token can send templates. Both are checked live before the feature is enabled.

## Design
1. **Canonical model:** `CatalogItem.imageUrl?: string` (https only, at most 2,000 characters, validated by the schema). Connectors map it: the mock fixtures, the generic REST mapping, and Bitrix24. The Bitrix24 product image field is not assumed; it is read from the official Bitrix24 docs when it is mapped.
2. **When:** only on Instagram. A turn that shows two or more catalog items (title facts in `shownFactIds`, after the AUD-10 checks) sends the normal text reply first, so desktop users and failures still get the list. One generic template follows it:
   - element `title` = the rendered title fact, cut to 80 characters;
   - no `subtitle` in v1, because descriptions are untrusted and may contain prices (D5);
   - `image_url` when present;
   - one `postback` button with a locale template label ("Batafsil", "Подробнее", "Details") and payload `item:<catalog item id>`.
   The carousel is code-rendered from facts; the model never writes it.
3. **Postback intake:** the normaliser accepts `messaging[].postback`. The tap becomes an inbound message whose text is the button `title` (what the customer saw) plus the payload. The payload is untrusted: the item id is looked up in the tenant's catalog through the connector, and an unknown id is ignored. A valid tap runs a normal agent turn with a details request for that item. Dedupe uses `postback.mid`.
4. **Sending:** a separate outbound message type with the same "never resend an ambiguous send" rules as direct messages. A failed template never blocks the text reply.
5. **Enable:** adding `messaging_postbacks` to the webhook subscription is an external change. It needs the owner's permission, plus a live check with an app-role account.

## Implementation notes (2026-11-09)
- `CatalogItem.imageUrl` (https, at most 2,000 characters). The generic REST connector maps `fieldMappings.item.imageUrl` (default path `imageUrl`); a bad image is dropped, never fatal for the item. Mock fixtures carry no images (a fake URL would be sent to Meta in demos).
- Title facts carry `itemId` and `imageUrl`; `buildCarousel` (channels/instagram/instagram-carousel.ts) uses only shown title facts, in shown order, at most 10, at least 2; not for handovers or the private reply to a comment. The spec is stored on the bot reply as `messages.rich_content` (JSONB) and sent by the processor right after the text is SENT: at most once, a failure is logged (`instagram.carousel_failed`) and never fails the text.
- Postback lookup, changed from point 3 above: the payload is matched against the carousels we stored for this conversation (last 20), not looked up through the connector. This is stricter (only items we offered to this customer), needs no CRM call in the webhook path, and the inbound text `<label>: <title>` is rebuilt from our own spec, so neither Meta's button title nor the payload reaches the agent. Unknown or malformed payloads are ignored.
- Subscription: `messaging_postbacks` is listed for Instagram Login and Unified login in the fields matrix (https://developers.facebook.com/documentation/instagram-platform/webhooks/fields.md, read 2026-11-09). New connections subscribe `messages,messaging_postbacks`; accounts connected before this change get it when they are enabled again (re-subscribe), which the live check covers.
- Bitrix24: the official docs (https://apidocs.bitrix24.com/api-reference/catalog/product-image/catalog-product-image-list.html, read 2026-11-09) give `catalog.productImage.list` → `productImages[]` with `type` (`DETAIL_PICTURE`, `PREVIEW_PICTURE`, `MORE_PHOTO`), `detailUrl` ("link to the image") and `downloadUrl` (sample carries a `token=`). Whether `detailUrl` is publicly fetchable is NOT stated. Our Bitrix24 connector is a lead sink only (no catalog read), so the mapping lands with Bitrix24 catalog search: `imageUrl` = the `DETAIL_PICTURE` `detailUrl`, after a live check that Meta can fetch it without auth.

## Risks
- Images come from the CRM: an image URL is untrusted data (only https; no fetching on our side).
- Volume: one extra send per answer with options; still inside the per-account rate lock.
