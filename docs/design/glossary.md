# Glossary — plain words for the operator UI

One concept, one word. Before using a new customer-facing term, add it here. Keep the en / ru / uz-Latn columns in sync.

| Concept | en | ru | uz-Latn | Replace |
|---|---|---|---|---|
| The AI that answers customers | Assistant | Ассистент | Yordamchi | "AI bot", "the bot", "bot" in labels that name the feature (nav, page titles, mode names, help text). Keep "Telegram bot token" — it is Telegram's own word — but say what it is in the hint. |
| The tab for linking Bitrix24 and similar | External CRM | Внешняя CRM | Tashqi CRM | "CRM integration", "CRM integratsiyasi", the bare "CRM" tab. The Leads page is the CRM itself; this tab links another one. |
| The funnel stages | Sales stages | Этапы продаж | Savdo bosqichlari | "Lead stages", "Lid bosqichlari", "Pipeline stage", "Voronka bosqichi", "Pipeline" as a user label. Keep "Voronka" only inside a sentence that explains it once. |
| A conversation waiting for a person | Needs an operator | Нужен оператор | Operator kerak | "Handover", "Operatorga topshirish" as labels. Keep only where it names a reason in analytics or inside a sentence. |
| Information the assistant may state only while fresh | Verified information (legal, medical, financial) | Проверенная информация (юридическая, медицинская, финансовая) | Tekshirilgan ma'lumot (huquqiy, tibbiy, moliyaviy) | "Regulated information" and its ru and uz forms. |
| Remove a customer's personal data (privacy erase) | Erase | Удалить | O‘chirish | "Clear personal data" / "Очистить личные данные" / "Shaxsiy ma’lumotni tozalash" (owner decision 2026-11-14: the plain words stay). |

## Words we avoid

| Avoid | Plain replacement | Notes |
|---|---|---|
| webhook | the server's public address (the address the messenger calls) | `channels.webhookUrl` stays "Webhook address" as the field name; do not explain webhooks to admins. |
| token | access key | Keep "Telegram bot token" where it is Telegram's own word. Never show an env var name to users. |
| handover | Needs an operator; the operator takes over | As a label: "Needs an operator". Inside a sentence the verb may stay. |
| pipeline | sales stages | When naming stages. Keep "pipeline" only when naming the pipeline entity itself. |
| regulated | verified information | "Verified information (legal, medical, financial)". |
| erase | erase / удалить / o‘chirish | Privacy erase only (owner decision 2026-11-14). "Delete for good" / "Archive" on leads stay unchanged. |

## Server setup in user-visible text

User-visible strings must never show an environment variable name (for example `SECRETS_MASTER_KEY`, `KNOWLEDGE_EMBEDDINGS`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN`). Say that the server needs secure storage or embeddings switched on, and that the technical administrator must do it in the server settings.

Role names, stage default names (New, Contacted, …), channel names and error codes are not glossary terms and are not changed here.


## Owner decisions, 2026-11-14
- "Lead sink" is shown as "Lidlarni qabul qilish" (uz-Latn); the wording stays as it is.
- "Voronka" / "Воронка" stays as the name of the pipeline entity (several pipelines per workspace); the stages inside are "Savdo bosqichlari" / "Этапы продаж".
- The English spelling is "email" (no hyphen) everywhere.
