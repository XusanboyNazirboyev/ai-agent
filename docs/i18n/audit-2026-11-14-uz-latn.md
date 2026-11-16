# i18n audit findings — uz-Latn (2026-11-14)

Source files audited: `apps/web/src/i18n/uz-Latn.json` against `en.json` and `ru.json`. Reference glossary: `docs/design/glossary.md`. All 1291 keys were read; every value was reviewed in groups (errors.*, toast.*, login.*, connectorRoles.*, sheet.*, leads.*, settings.* + settings.section.*, channels.*, knowledge.*, contacts.*, people.*, mfa.*, then the rest). No code or string was changed.

## 1. Mechanical scan results

### 1.1 Key parity (en ↔ uz ↔ ru)
| Check | Result |
|---|---|
| uz keys total | 1291 |
| en keys total | 1291 |
| ru keys total | 1291 |
| uz keys also in en | 1291 (all) |
| uz keys missing from en | 0 |
| en keys missing from uz | 0 |
| uz keys also in ru | 1291 (all) |
| ru keys missing from uz | 0 |

Verdict: perfect key parity; no missing or surplus keys in uz-Latn.

### 1.2 Apostrophes and special marks
| Check | Result |
|---|---|
| ASCII apostrophe `'` | 0 |
| Backtick `` ` `` | 0 |
| Accent acute `´` | 0 |
| Modifier `ʻ` (U+02BB) | 0 |
| Modifier `ʼ` (U+02BC) | 0 |
| Wrong sign `’` after `o` or `g` | 0 |
| Sign `‘` after a non-o/g letter | 0 |

Verdict: clean. The file consistently uses `‘` (U+2018) for `o‘`/`g‘` and `’` (U+2019) as the Uzbek sign (e.g. `ma’lumot`, `CRM’da`, `webhook’ini`), exactly as the glossary prescribes. The previous 19 ASCII-apostrophe defects (fixed in the base branch) are gone.

### 1.3 Placeholder parity (en → uz)
29 keys reorder ICU placeholders for Uzbek word order (e.g. `{part} of {total}` → `{total} tadan {part}`). All placeholder **names** are preserved; none are missing or added. Example: `analytics.sub.ofTotal`, `console.planOption`, `console.audit.page`, `subscription.pricePer`, `team.seats`. This is expected in translation, not a defect.

### 1.4 Untranslated values (uz == en)
14 values are byte-identical to en, all justified:
- `locale.en/ru/uz-Latn` — language names stay in their own script (correct).
- `header.signedInAs` — `{name} ({role})` format string.
- `role.OPERATOR`, `author.OPERATOR`, `mode.operator` — "Operator" is the same word in Uzbek.
- `app.brand` — "tezda" (brand).
- `knowledge.counter` — `{used} / {max}` format string.
- `group.id` — "Chat id" (technical term, standard in Uzbek tech usage).
- `mode.ai` — "AI".
- `console.subscription.period` — `{start} – {end}` format string.
- `paymentProvider.CLICK` — "Click" (payment provider name).
- `leads.aiChip` — "AI".

No genuinely untranslated string.

### 1.5 Spacing and punctuation
6 mechanical flags, all false positives on review:
- `documents.file`, `sheet.intro`: space before `(` in file-extension parentheticals — acceptable.
- `errors.INVALID_WEBHOOK_URL`, `errors.SHEET_NO_ROWS`, `errors.XLSX_NO_DATA`, `errors.XLSX_OLD_FORMAT`: end-of-string or URL/extension adjacency — not real errors.
- `errors.XLSX_UNREADABLE`, `errors.XLSX_OLD_FORMAT`: space before `.xlsx` (word separation) and `»ni` (correct Uzbek typography with closing guillemet).

No double spaces, leading/trailing spaces, double dots, or straight quotes.

### 1.6 Single-occurrence words (>5 letters)
807 words occur once — expected in a translation file of this size; flagged for native-speaker review rather than treated as defects. One suspicious item: `assistent` in `channels.desc.facebook` (see §2). All other long single-occurrence words are normal Uzbek content words or brands.

### 1.7 Glossary terms / avoided forms
| Term | Result |
|---|---|
| `bot` meaning the assistant (should be `Yordamchi`) | 5 keys still use `bot` for the assistant: `analytics.tile.autoResolved` ("Bot hal qilgan"), `handover.reason.GUARDRAIL` ("Bot javobi..."), `handover.reason.TOOL_LOOP_LIMIT` ("Bot javob topa olmadi"), `handover.intent.ai_question` ("bot haqida savol"), `handover.group.inferences` ("Bot tushungani"). All other `bot` uses correctly refer to the Telegram bot / bot token. |
| `lead` instead of `lid` | 0 — correct, `lid` used throughout. |
| `voronka` | 11 keys in `pipelines.*` (pipeline/funnel entity names). Acceptable as entity names; not user-facing stage labels. |
| `pipeline` | 0 — correct. |
| `handover` | 0 — correct ("Operator kerak"-style phrasing used). |
| `webhook` / `token` in user sentences | 13 webhook / 7 token uses, all in technical admin/channel-setup context (webhook URL, access token, bot token). Acceptable; `channels.webhookUrl` kept as field name per glossary. |

### 1.8 Long values in UI label keys
0 values over 140 chars in `*.label`, `*.title`, `*.badge`, `*.button` or `nav.*` keys. No truncation risk.

## 2. Part 2 — full reading of every value

Read in groups, in order: `errors.*`, `toast.*`, `login.*`, `connectorRoles.*`, `sheet.*`, `leads.*`, `settings.*` + `settings.section.*`, `channels.*`, `knowledge.*`, `contacts.*`, `people.*`, `mfa.*`, then the rest.

Observations by group:

- **errors.***: Spelling/grammar correct. `o‘rinlar` used for seats/availability (consistent with glossary D14). No env-var names (`SECRETS_MASTER_KEY`, `KNOWLEDGE_EMBEDDINGS`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN`) appear in user-visible text. `webhook` appears only in technical channel-setup errors (acceptable).
- **toast.***: Concise, correct. `yordamchi` used for the assistant (e.g. `toast.returnToBot`: "Suhbat yordamchiga qaytarildi.").
- **login.***: Correct. `login.point3`: "Barcha narx va sanalar sizning ma’lumotlaringizdan olinadi" — matches en meaning.
- **connectorRoles.***: Correct. `CATALOG`, `LEAD_SINK`, `ACTIONS` roles translated; status values clear.
- **sheet.***: All sheet-catalog strings read. Correct terminology (`narx ro‘yxati`, `ustun`, `qator`, `jo‘nash sanasi`). `sheet.intro` correctly states prices come only from the price list.
- **leads.***: `lid` used consistently (not `lead`). `Savdo bosqichlari` used for stages (consistent with glossary). `leads.ageLabel` ICU plural both branches identical — matches en pattern, acceptable.
- **settings.*** / **settings.section.***: `Sozlamalar`, `Tashqi CRM`, `Savdo bosqichlari`, `Xodimlar`, `Obuna`, `Xavfsizlik`, `Narx ro‘yxati`, `Teglar va maydonlar` — all consistent with glossary.
- **channels.***: `channels.desc.facebook` uses `assistent` ("assistent javob beradi") — **inconsistent** with the 55 other `yordamchi` uses; should be `yordamchi javob beradi`. All other channel strings correct.
- **knowledge.***: Correct. `Tekshirilgan ma’lumot` for regulated information (consistent with glossary). `knowledge.notConfigured` avoids env-var names.
- **contacts.***: Correct. `Kontakt`, `Rozilik` consent values clear.
- **people.***: Correct. `Odamlar`, `Lidlar`, `Kontaktlar`. `people.duplicatesBanner` ICU plural both branches identical — matches en pattern.
- **mfa.***: Correct. `Ikki bosqichli kirish`, `Zaxira kod`, `Sozlash kaliti`.
- **console.* / platform.* / team.* / subscription.* / payment.***: Correct console-tenant strings. `tezda` brand used where en uses "tezda". `console.subscription.period` identical to en (`{start} – {end}`) — justified format string.
- **analytics.***: Correct. `Resolved by the bot` → `Bot hal qilgan` — same `bot`-for-assistant inconsistency noted in §1.7.
- **legal.***: `Huquqiy ma’lumot`, `Maxfiylik siyosati`, `Ma’lumotlarni o‘chirish`, `Foydalanish shartlari` — correct.
- **handover.***: Reasons and intents translated; `bot` used for the assistant in `GUARDRAIL`, `TOOL_LOOP_LIMIT`, `ai_question`, `group.inferences` — same inconsistency as §1.7.
- **Rest (app.*, nav.*, state.*, author.*, delivery.*, score.*, canned.*, connection.*, notify.*, list.*, view.*, action.*, actionStatus.*, confirm.*, theme.*, permission.*, notfound.*, errorPage.*, agentMode.*, bot.*, group.*, disconnect.*, test.*, instagram.*, igConnect.*, fbCallback.*, voice.*, comment.*, banner.*, invite.*, importProblem.*, access.*, platformRole.*, tenantStatus.*, subscriptionStatus.*, accessState.*, paymentStatus.*, paymentProvider.*, console.*)**: All read; spelling, grammar, and tone consistent. `yordamchi` used for the assistant in 55 keys; `bot` reserved for the Telegram bot/token except the 5 keys noted above.

## 3. Defects found (severity)

**FIXABLE (string-level):**
1. `channels.desc.facebook`: `assistent javob beradi` → `yordamchi javob beradi` (glossary B1: one word for the assistant; `yordamchi` used 55× elsewhere).
2. `analytics.tile.autoResolved`: `Bot hal qilgan` → `Yordamchi hal qilgan` (bot→assistant).
3. `handover.reason.GUARDRAIL`: `Bot javobi xavfsizlik tekshiruvidan o‘tmadi` → `Yordamchi javobi...`.
4. `handover.reason.TOOL_LOOP_LIMIT`: `Bot javob topa olmadi` → `Yordamchi javob topa olmadi`.
5. `handover.intent.ai_question`: `bot haqida savol` → `yordamchi haqida savol`.
6. `handover.group.inferences`: `Bot tushungani` → `Yordamchi tushungani`.

**NOT defects (reviewer notes):**
- `voronka` in `pipelines.*` (11 keys): entity names, acceptable per glossary.
- `webhook`/`token` in technical channel-setup strings: acceptable; field name `channels.webhookUrl` retained.
- 14 en-identical values: all justified (language names, formats, brands).
- `o‘rinlar` for seats/availability: consistent with glossary D14.
- 807 single-occurrence long words: normal; for native-speaker review only.

## 4. Scan scripts used (read-only, not saved as files)

All checks were run with `python3 -I` reading the three JSON files, producing only aggregated counts and listed keys. No script file was added to the repo. Key scripts: key-parity set comparison; apostrophe/mark regex scan (`'`, `` ` ``, `´`, `ʻ`, `ʼ`, `’`, `‘`); ICU placeholder-name comparison (`\{[^}]+\}`); en-identical value comparison; spacing/punctuation regex scan; single-occurrence word frequency; glossary term regex scan; length check on label/title/badge/button/nav keys.

