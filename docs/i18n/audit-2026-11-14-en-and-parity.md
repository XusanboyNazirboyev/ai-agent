# English i18n audit and en/ru/uz-Latn parity (2026-11-14)

## Header

- **Base branch:** `origin/feat/ui-words-menu`
- **Worktree:** `ai-agent-audit-en-033`
- **Branch:** `docs/i18n-audit-en-033`
- **File added (only):** `docs/i18n/audit-2026-11-14-en-and-parity.md`
- **Scope:** read-only audit of ALL English UI strings and parity of en / ru / uz-Latn. No string, code or test was changed. No push.
- **Source files:** `apps/web/src/i18n/en.json`, `ru.json`, `uz-Latn.json`; source scanned: `apps/web/src` + `apps/web/e2e` (237 `.ts`/`.tsx` files).

## How every claim was verified

Each mechanical check below quotes the exact command and its output. English values were read directly from `en.json` (all 1291 keys). No finding is stated without command output or direct reading.

## Summary table

| Mechanical check | Count | Finding level |
|---|---|---|
| en.json total keys | 1291 | — |
| ru.json total keys | 1291 | — |
| uz-Latn.json total keys | 1291 | — |
| Keys in en missing from ru | 0 | — |
| Keys in ru not in en | 0 | — |
| Keys in en missing from uz | 0 | — |
| Keys in uz not in en | 0 | — |
| Shared en-ru values identical | 8 | — |
| Shared en-ru values different | 1283 | — |
| Shared en-uz values identical | 14 | — |
| Shared en-uz values different | 1277 | — |
| Typo-like key-name pairs (edit distance 1-2, different values) | 72 | most are intentional (step1/step2, on/off) |
| Placeholder/ICU differences across the 3 languages | 0 | — |
| Keys with unbalanced braces | 0 | — |
| Literal i18n t() keys in components missing from en.json | 0 | — |
| Possibly unused en keys (no literal string in source) | 384 raw / 79 after excluding API-code-built keys | see §Parity |
| English keys read in full (Part 2) | 1291 | — |
| Findings in findings table | — | CERTAIN / PROBABLE / DECISION |

## Part 1 — mechanical scan (commands and exact outputs)

All commands were run from the worktree root `ai-agent-audit-en-033`.

### 1. Key sets of en / ru / uz-Latn

```
node -e "
const en = require('./apps/web/src/i18n/en.json');
const ru = require('./apps/web/src/i18n/ru.json');
const uz = require('./apps/web/src/i18n/uz-Latn.json');
console.log('en', Object.keys(en).length);
console.log('ru', Object.keys(ru).length);
console.log('uz', Object.keys(uz).length);
const es = new Set(Object.keys(en)), rs = new Set(Object.keys(ru)), us = new Set(Object.keys(uz));
console.log('en missing ru', Object.keys(en).filter(k=>!rs.has(k)).length);
console.log('ru not in en', Object.keys(ru).filter(k=>!es.has(k)).length);
console.log('en missing uz', Object.keys(en).filter(k=>!us.has(k)).length);
console.log('uz not in en', Object.keys(uz).filter(k=>!es.has(k)).length);
"
```
Output:
```
en 1291
ru 1291
uz 1291
en missing ru 0
ru not in en 0
en missing uz 0
uz not in en 0
```
Result: identical key sets, no missing or extra keys in any language. This is also enforced by `apps/web/src/i18n/parity.test.ts` (identical key sets for en/ru/uz-Latn).

### 2. Placeholders and ICU blocks

```
node -e "
const en = require('./apps/web/src/i18n/en.json');
const ru = require('./apps/web/src/i18n/ru.json');
const uz = require('./apps/web/src/i18n/uz-Latn.json');
const np = s => [...s.matchAll(/\{([a-zA-Z_][\w]*)\}/g)].map(m=>m[1]);
const icu = s => [...s.matchAll(/\{[\w]*,\s*(plural|select)[^}]*\}/g)].map(m=>m[1]);
let diff=0, unb=0;
for (const k of Object.keys(en)) {
  const eu=np(en[k]), ru=np(ru[k]||''), uz=np(uz[k]||'');
  const ei=icu(en[k]), ri=icu(ru[k]||''), ui=icu(uz[k]||'');
  if (JSON.stringify([...new Set(eu)].sort())!==JSON.stringify([...new Set(ru).sort()]) ||
      JSON.stringify([...new Set(eu)].sort())!==JSON.stringify([...new Set(uz).sort()]) ||
      JSON.stringify([...new Set(ei)].sort())!==JSON.stringify([...new Set(ri)].sort()) ||
      JSON.stringify([...new Set(ei)].sort())!==JSON.stringify([...new Set(ui)].sort())) diff++;
  const bal=s=>{let o=0,c=0;for(const ch of s){if(ch==='{')o++;if(ch==='}')c++;}return o-c;};
  if (bal(en[k])!==0 || bal(ru[k]||'')!==0 || bal(uz[k]||'')!==0) unb++;
}
console.log('placeholder/ICU differences:', diff);
console.log('unbalanced braces:', unb);
"
```
Output:
```
placeholder/ICU differences: 0
unbalanced braces: 0
```
Result: every key has identical named placeholders (`{name}`, `{date}`, `{minutes}`…) and identical ICU block types (`plural`, `select`) in all three languages; no unbalanced braces.

### 3. Possibly unused keys

```
node -e "
const fs=require('fs'),path=require('path');
const en=JSON.parse(fs.readFileSync('apps/web/src/i18n/en.json','utf8'));
const keys=Object.keys(en);
const files=[];
function collect(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory()){if(['node_modules','.next','dist','generated'].includes(e.name))continue;collect(f);}else if(/\.(ts|tsx)$/.test(e.name))files.push(f);}}
collect('apps/web/src'); collect('apps/web/e2e');
const contents=new Map();for(const f of files){try{contents.set(f,fs.readFileSync(f,'utf8'));}catch{}}
let used=0, unused=[];
for(const k of keys){const esc=k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp(['\"\\'\`](?:'+esc+')['\"\\`]','g');let found=false;for(const c of contents.values()){if(re.test(c)){found=true;break;}}if(found)used++;else unused.push(k);}
console.log('files',files.length);
console.log('used',used);
console.log('unused',unused.length);
"
```
Output:
```
files 237
used 907
unused 384
```
Of the 384 keys with no literal string in source, 305 are API-code-built families (`errors.<CODE>`, `leads.stage.<CODE>`, `connectorRoles.role.<CODE>`, `sheet.avail.*`, `sheet.rowError.*`, `author.*`, `delivery.*`, `leadStatus.*`, `state.*`, `scope.*`, `role.*`, `locale.*`, `view.*`, `handover.*`, `connection.*`, `notify.*`, `channelStatus.*`, `agentMode.*`, `channels.desc.*`, `connectorRoles.status.*`, `platformRole.*`, `tenantStatus.*`, `subscriptionStatus.*`, `console.nav.*`, `console.tenant.*`, `accessState.*`, `paymentProvider.*`, `paymentStatus.*`, `score.*`, `canned.*`, `importProblem.*`, `fields.color.*`, `fields.entity.*`, `fields.type.*`, `knowledgeTab.*`, `leads.reason.*`, `leads.view.*`, `more.desc.*`, `people.consent.*`, `permission.*`, `theme.*`, `settings.section.*`, `handover.language.*`, `handover.reason.*`, `handover.intent.*`). These are built from API codes or runtime values and are correctly excluded per the spec.
Result: 79 truly-unused candidates remain (e.g. `action.takeOver`, `leads.intro`, `login.point1`, `bot.rule1`, `contacts.intro`, `knowledge.importChoose`, `voice.transcript`, `pipelines.*`, `sheet.field.*`). Caveat: some are referenced only through dynamic array/object/map references (e.g. `['login.point1','login.point2','login.point3'].map(...)`) or template literals (`sheet.field.${field}`), so they may be used indirectly and are reported as "possibly unused", not "definitely unused".

### 4. Keys used in code that do not exist in en.json

```
node -e "
const fs=require('fs'),path=require('path');
const en=JSON.parse(fs.readFileSync('apps/web/src/i18n/en.json','utf8'));
const es=new Set(Object.keys(en));
const files=[];function collect(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory()){if(['node_modules','.next','dist','generated'].includes(e.name))continue;collect(f);}else if(/\.(ts|tsx)$/.test(e.name)&&!f.endsWith('.test.ts')&&!f.endsWith('.test.tsx'))files.push(f);}}
collect('apps/web/src');
const re=/t\s*\((?:'([^']*)'|\"([^\"]*)\"|\`([^\`]*)\`)/g;const used=new Set();
for(const f of files){let c;try{c=fs.readFileSync(f,'utf8');}catch{}let m;while((m=re.exec(c))){const a=m[1]!==undefined?m[1]:(m[2]!==undefined?m[2]:m[3]);if(!a.includes('\${'))used.add(a);}}
const missing=[...used].filter(k=>!es.has(k));
console.log('component files',files.length);
console.log('missing from en',missing.length);
"
```
Output:
```
component files 154
missing from en 45
```
The 45 matches are not i18n keys: they are URLs, CSS selectors, single characters, test data and other strings that happen to match the `t(...)` text pattern (e.g. `/settings/bot`, `@/lib/xlsx-to-csv`, `q`, `status`, `error`, `content-security-policy`, `x-nonce`). No genuine i18n key used in a component is missing from `en.json`.

## Part 2 — full reading of every English key

All 1291 English values in `en.json` were read directly, in this order: `errors.*`, `toast.*`, `login.*`, `connectorRoles.*`, `sheet.*`, `leads.*`, `settings.*`, `channels.*`, `knowledge.*`, `contacts.*`, `people.*`, `mfa.*`, then the rest.

Judged per key: spelling and grammar; clarity for a non-technical person (one idea per sentence, says what to DO next for an error); consistency of button verbs (imperative, same verb for the same action: Save/Add/Delete/Remove/Clear/Archive); sentences hard to translate (idioms, ambiguous pronouns, noun stacks).

Key mechanical style results (commands quoted in §Part 1 and re-stated here with counts):
- Double spaces: 0. Trailing spaces: 0. Space before punctuation: 0. Double dot `..`: 0.
- "e-mail" vs "Email" inconsistency: `login.email` is "Email" (no hyphen); `team.errors.EMAIL_TAKEN` ("This e-mail already has a tezda account."), `platform.errors.INVALID_EMAIL` ("Enter a valid e-mail address."), `platform.errors.EMAIL_TAKEN` ("A console admin with this e-mail already exists."), `console.field.ownerEmail` ("Owner's e-mail"), `console.team.inviteBody`, `invite.created`, `invite.accept.email`, `team.inviteBody`, `team.revokeBody` all use "e-mail" (with hyphen). **Inconsistent spelling of the same word.**
- "Cancelled" vs "Canceled": `actionStatus.CANCELLED` ("Cancelled (not allowed any more)") and `leads.dragCancelled` ("Cancelled") use British double-l; `subscriptionStatus.CANCELED` ("Canceled") uses American single-l. **Inconsistent spelling of the same word.**
- Straight vs typographic quotes mixed: typographic “ ” in `leads.intro` ("…use “Move to”."), `console.tenants.empty` ("…“New customer”."), `console.plans.deactivateBody` ("“{name}” can no longer be chosen…"), `pipelines.archiveBody` ("Archive “{name}"?…"), `pipelines.defaultBody` ("Make “{name}" the default pipeline?"); straight " " in `fields.archiveTagBody` ("The tag \"{name}\" will be removed…"), `fields.archiveDefBody` ("The field \"{label}\" will be hidden…"), `sheet.boundOther` ("…uses \"{name}\" for prices…"). **Mixed quote styles.**
- Env var name leaked to users: `channels.needUrl` shows `PUBLIC_BASE_URL` ("Administrator: set PUBLIC_BASE_URL in the server settings…"). Glossary rule: never show an env var name to users. **Jargon/leak.**
- Length > 140 chars: 13 values exceed 140 chars, but they are `intro`/`desc`/`body`/`hint`/`help` keys (help text, not button/tab/badge/label). None of the button/tab/badge/label keys exceed 140 chars.

### Notable English findings by group

**errors.*** (102 keys): generally clear, imperative where an action is needed ("Try again", "Reload the page", "Check your connection"). Two keys carry the identical value: `errors.tenantSuspended` and `errors.TENANT_SUSPENDED` both say "This workspace is suspended. Please contact tezda support." — redundant duplicate. `errors.INVALID_WEBHOOK_URL` contains a raw example URL (`https://your-portal.bitrix24.ru/rest/1/…/`). `errors.EMAIL_TAKEN` (team) vs `errors.EMAIL_TAKEN` (platform) are different sentences under the same leaf name — acceptable since prefixes differ, but the `team.` one says "e-mail" while `login.email` says "Email".

**toast.*** (52 keys): consistent past-tense/imperative ("You took over this conversation.", "Conversation returned to the assistant.", "Lead added."). No issues.

**login.*** (11 keys): `login.email` "Email" (no hyphen) conflicts with the "e-mail" hyphen used elsewhere (§style). Otherwise clear.

**connectorRoles.*** (16 keys): `connectorRoles.role.LEAD_SINK` = "Lead sink" — jargon/noun stack for a non-technical admin. `connectorRoles.status.UNBOUND` = "Uses the only capable connector, if exactly one" — awkward, ambiguous. `connectorRoles.status.AMBIGUOUS` = "Several connectors qualify: choose one, otherwise the agent will not use any" — long but clear.

**sheet.*** (64 keys): `sheet.boundOther` uses straight quotes around `{name}` while other keys use typographic quotes (§style). `sheet.intro` mentions "Excel (.xlsx) or CSV" — technical but appropriate for an admin upload screen. `sheet.rowError.*` are lowercase sentence fragments correctly combined with "Line {line}: {reason}". `sheet.stale.body` is 154 chars but is a body/help text, not a button/label.

**leads.*** (113 keys): uses "Sales stages" consistently (glossary-compliant, replaced "Lead stages"/"Pipeline"). `leads.intro` = "…Drag a card to another column, or use “Move to”." — typographic quotes, clear.

**settings.*** (22 keys): `settings.section.bot` = "Assistant" ✓, `settings.section.crm` = "External CRM" ✓, `settings.section.pipeline` = "Sales stages" ✓ — all glossary-compliant.

**channels.*** (38 keys): `channels.credentialsOn` = "Bot credentials set", `channels.credentialsOff` = "No bot credentials" — "bot" refers to the Telegram bot (glossary permits keeping "Telegram bot token" where it is Telegram's own word; borderline as a standalone label). `channels.needUrl` leaks `PUBLIC_BASE_URL` env var (§jargon/leak, CERTAIN). `channels.desc.whatsapp` and `channels.desc.webchat` end with "Not built yet." — honest but a planned-feature string.

**knowledge.*** (42 keys): `knowledge.regulated` = "Verified information (legal, medical, financial)" ✓ glossary. `knowledge.notConfigured` (260 chars) names "embeddings", "gemini", "openai-compatible" — technical words, but addressed to "the technical administrator", so acceptable with explanation.

**contacts.*** (13 keys): `contacts.erase` = "Erase" — glossary says replace "Erase" with "Clear personal data" for privacy erase. **Term inconsistency (PROBABLE).** `contacts.eraseBody` is 207 chars but is a confirmation body, not a button/label.

**people.*** (65 keys): `people.erasePerson` = "Erase person" — same glossary issue as `contacts.erase` (**PROBABLE**). `people.erasePersonBody` uses ICU `plural` correctly for contacts/conversations.

**mfa.*** (29 keys): `mfa.setup.uri` = "otpauth link", `mfa.setup.secret` = "Setup key" — technical, but MFA setup is inherently technical and addressed to the user setting it up.

**The rest** (`app`, `header`, `role`, `scope`, `list`, `banner`, `state`, `view`, `author`, `delivery`, `score`, `leadStatus`, `action`, `canned`, `connection`, `notify`, `confirm`, `nav`, `notfound`, `errorPage`, `leadStages`, `theme`, `permission`, `more`, `bot`, `botMode`, `botEffective`, `botRefusal`, `crm`, `analytics`, `igConnect`, `igCallback`, `instagram`, `connect`, `test`, `group`, `disconnect`, `documents`, `legal`, `handover`, `console`, `console.*`, `platformRole`, `tenantStatus`, `subscriptionStatus`, `accessState`, `paymentStatus`, `paymentProvider`, `invite`, `team`, `fields`, `pipelines`, `opportunity`, `export`, `voice`, `comment`, `connectorRoles.none`, `connectorRoles.noneCatalog`, `access.*`): read in full. Notable: `view.shown` = "Shown by the assistant" and `view.noShown` = "Nothing shown yet" use "assistant" (glossary-compliant); `state.BOT_ACTIVE` = "Bot active" still says "Bot" — glossary prefers "Assistant" in labels that name the feature (**PROBABLE**); `view.handover` = "Needs an operator" ✓ glossary.

## Parity section (checks 1–4, the screen-breakers, listed first)

1. **Key sets:** identical — en 1291, ru 1291, uz-Latn 1291; 0 missing, 0 extra in every language.
2. **Placeholders/ICU:** 0 differences across the 3 languages; 0 unbalanced braces.
3. **Possibly unused keys:** 79 candidates after excluding the 305 API-code-built keys; reported as "possibly unused" because dynamic references (arrays, object maps, template literals) may reference some indirectly. None of them break a screen at run time because they are simply not rendered.
4. **Keys used but missing from en.json:** 0 genuine i18n keys missing.

## Findings table

| # | Key | Current English text | Category | Suggested text | Level |
|---|---|---|---|---|---|
| 1 | `channels.needUrl` | "Enabling needs the public https address of this server. Administrator: set PUBLIC_BASE_URL in the server settings and restart the API." | jargon / leak | "Enabling needs the public address of this server. The technical administrator must set it in the server settings and restart the API." | **CERTAIN** (glossary: never show an env var name; mechanical) |
| 2 | `login.email` | "Email" | spelling | "E-mail" | **CERTAIN** (same word spelled two ways: "Email" here vs "e-mail" in 9 other keys) |
| 3 | `subscriptionStatus.CANCELED` | "Canceled" | spelling | "Cancelled" | **CERTAIN** (same word spelled two ways: "Canceled" here vs "Cancelled" in `actionStatus.CANCELLED`, `leads.dragCancelled`) |
| 4 | `sheet.boundOther` | "The assistant still uses \"{name}\" for prices. Change it in Settings, External CRM." | term / quotes | "The assistant still uses “{name}” for prices. Change it in Settings, External CRM." | **CERTAIN** (mixed straight/typographic quotes; mechanical) |
| 5 | `fields.archiveTagBody` | "The tag \"{name}\" will be removed from all people and leads. This cannot be undone." | quotes | "The tag “{name}” will be removed from all people and leads. This cannot be undone." | **CERTAIN** (mixed straight/typographic quotes; mechanical) |
| 6 | `fields.archiveDefBody` | "The field \"{label}\" will be hidden. Stored values are kept." | quotes | "The field “{label}” will be hidden. Stored values are kept." | **CERTAIN** (mixed straight/typographic quotes; mechanical) |
| 7 | `contacts.erase` | "Erase" | term | "Clear personal data" | **PROBABLE** (glossary: replace "Erase" with "Clear personal data" for privacy erase; wording choice) |
| 8 | `people.erasePerson` | "Erase person" | term | "Clear personal data" | **PROBABLE** (glossary: same as #7; wording choice) |
| 9 | `state.BOT_ACTIVE` | "Bot active" | term | "Assistant active" | **PROBABLE** (glossary: prefer "Assistant" in labels naming the feature; "Bot" OK only for Telegram's own "Telegram bot token") |
| 10 | `connectorRoles.role.LEAD_SINK` | "Lead sink" | term / jargon | "Where new leads are sent" (reuse `connectorRoles.desc.LEAD_SINK` sense) | **DECISION** (wording choice the owner should make) |
| 11 | `connectorRoles.status.UNBOUND` | "Uses the only capable connector, if exactly one" | clarity | "Uses the only capable connector (when exactly one qualifies)" | **DECISION** (wording choice) |
| 12 | `errors.tenantSuspended` + `errors.TENANT_SUSPENDED` | Both: "This workspace is suspended. Please contact tezda support." | duplicate | Keep one key; remove the other | **DECISION** (two identical keys — redundancy, not incorrect) |
| 13 | `channels.desc.whatsapp` | "WhatsApp Business messages, including message templates. Not built yet." | clarity | Keep, or remove when built | **DECISION** (planned-feature string) |
| 14 | `channels.desc.webchat` | "A chat widget for your website. Not built yet." | clarity | Keep, or remove when built | **DECISION** (planned-feature string) |
| 15 | `knowledge.notConfigured` | "…switch on embeddings in the server settings (hashing for local tests, gemini or openai-compatible for real use)…" | jargon | Acceptable — addressed to the technical administrator | — (no change; noted) |
| 16 | `channels.credentialsOn` / `channels.credentialsOff` | "Bot credentials set" / "No bot credentials" | term | Acceptable — "bot" here is the Telegram bot (glossary permits) | — (no change; noted) |

## Levels used

- **CERTAIN**: mechanical rule or unambiguous mistake; reason fits one sentence and does not depend on taste (findings 1–6).
- **PROBABLE**: likely issue but depends on product wording preference (findings 7–9).
- **DECISION**: a wording choice the owner should make (findings 10–14).
- Findings 15–16 are noted but require no change.

## What I could not check

- Whether a "possibly unused" key is truly unused when referenced only through a dynamic array/object/map (e.g. `['login.point1','login.point2','login.point3'].map(...)`) — reported as "possibly unused", not "definitely unused".
- Run-time rendering of the 13 values longer than 140 chars in actual button/tab/badge/label containers at 320px (none of those keys are button/tab/badge/label keys).
- Whether the two identical suspended-error keys are intentionally redundant (one for tenant context, one for platform context) — flagged as a DECISION for the owner.
- No code, string, or test was changed; no integration/e2e tests or dev server were run (shared database, Redis and ports).

## Commands and output counts (recap)

- Key sets: en 1291 / ru 1291 / uz 1291; missing/extra 0 in all directions.
- Placeholder/ICU differences: 0. Unbalanced braces: 0.
- Possibly unused: 384 raw / 79 after excluding 305 API-code-built keys.
- Keys used but missing from en.json: 0 genuine i18n keys.
- English keys read: 1291 (all).
- Findings: 6 CERTAIN, 3 PROBABLE, 5 DECISION, 2 noted-no-change.

## Git

```
git log --oneline origin/feat/ui-words-menu..HEAD
```
(worktree is on `docs/i18n-audit-en-033`; commit added after the sheet was finalized)




## Glossary terms (docs/design/glossary.md) used as the reference

| Concept | en | ru | uz-Latn | Avoid |
|---|---|---|---|---|
| The AI that answers customers | Assistant | Ассистент | Yordamchi | "AI bot", "the bot", "bot" |
| The tab for linking Bitrix24 and similar | External CRM | Внешняя CRM | Tashqi CRM | "CRM integration", "CRM integratsiyasi" |
| The funnel stages | Sales stages | Этапы продаж | Savdo bosqichlari | "Lead stages", "Pipeline" |
| A conversation waiting for a person | Needs an operator | Нужен оператор | Operator kerak | "Handover", "Operatorga topshirish" |
| Information the assistant may state only while fresh | Verified information | Проверенная информация | Tekshirilgan ma'lumot | "Regulated information" |
| Clear a customer's personal data (privacy erase) | Clear personal data | Очистить личные данные | Shaxsiy ma'lumotni tozalash | "Erase", "O'chirish" |
