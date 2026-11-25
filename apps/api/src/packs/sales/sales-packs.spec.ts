import { describe, expect, it } from 'vitest';
import { extraction, runTurn } from '../../agent/testing/agent-harness.js';
import { MockConnector } from '../../connectors/mock/mock-connector.js';
import { extractionSystemPrompt } from '../../core/agent/prompts.js';
import type { Intent } from '../../core/agent/slots.js';
import { scoreLead } from '../../core/leads/scoring.js';
import {
  ScriptedLlmProvider,
  type ScriptStep,
} from '../../core/llm/scripted-llm-provider.js';
import { INITIAL_LOCALE_PACKS } from '../../locales/locale-packs.js';
import { AUTO_SALES_PACK } from '../auto-sales/auto-sales.pack.js';
import { FURNITURE_PACK } from '../furniture/furniture.pack.js';
import { HOME_APPLIANCES_PACK } from '../home-appliances/home-appliances.pack.js';
import { REAL_ESTATE_PACK } from '../real-estate/real-estate.pack.js';
import { DOMAIN_PACKS, SIGNUP_PACK_KEYS, packByKey } from '../registry.js';
import { SERVICES_PACK } from '../services/services.pack.js';

const cases = [
  {
    pack: FURNITURE_PACK,
    primary: 'furniture',
    title: 'Atlas Wardrobe',
    preference: ['quantity', ['2', '2', '2', '2']],
  },
  {
    pack: HOME_APPLIANCES_PACK,
    primary: 'appliance',
    title: 'Atlas Washer',
    preference: ['quantity', ['2', '2', '2', '2']],
  },
  {
    pack: AUTO_SALES_PACK,
    primary: 'vehicle',
    title: 'Atlas Sedan',
    preference: [
      'vehicle_condition',
      ['yurgan', 'юрган', 'подержанный', 'used'],
    ],
  },
  {
    pack: REAL_ESTATE_PACK,
    primary: 'property',
    title: 'Atlas Apartment',
    preference: ['rooms', ['2', '2', '2', '2']],
  },
  {
    pack: SERVICES_PACK,
    primary: 'service',
    title: 'Atlas Home Cleaning',
    preference: ['preferred_time', ['juma', 'жума', 'пятница', 'Friday']],
  },
] as const;

const locales = [
  {
    id: 'uz-Latn',
    language: 'uz',
    script: 'Latn',
    hello: 'Assalomu alaykum',
    find: 'Atlas haqida ma’lumot bering',
    price: 'Atlas narxi qancha?',
    reply: 'Sizga {{F1}} mos keladi.',
    quote: '{{F1}} narxi: {{F4}}.',
    operator: 'Operator bilan gaplashmoqchiman',
  },
  {
    id: 'uz-Cyrl',
    language: 'uz',
    script: 'Cyrl',
    hello: 'Ассалому алайкум',
    find: 'Atlas ҳақида маълумот беринг',
    price: 'Илтимос, Atlas маҳсулотининг нархи қанча эканини айтиб беринг.',
    reply: 'Сизга {{F1}} мос келади.',
    quote: '{{F1}} нархи: {{F4}}.',
    operator: 'Оператор билан гаплашмоқчиман',
  },
  {
    id: 'ru',
    language: 'ru',
    script: 'Cyrl',
    hello: 'Здравствуйте',
    find: 'Что есть в каталоге Atlas?',
    price:
      'Подскажите, пожалуйста, сколько стоит позиция Atlas в вашем каталоге?',
    reply: 'Вам подойдёт {{F1}}.',
    quote: 'Цена {{F1}}: {{F4}}.',
    operator: 'Соедините меня с оператором',
  },
  {
    id: 'en',
    language: 'en',
    script: 'Latn',
    hello: 'Hello',
    find: 'Tell me about Atlas',
    price: 'How much does Atlas cost?',
    reply: 'The {{F1}} is a good fit.',
    quote: 'The {{F1}} costs {{F4}}.',
    operator: 'I want to speak to a person',
  },
] as const;

for (const { pack, primary, title, preference } of cases) {
  describe(pack.key, () => {
    const source = `mock-${pack.key}`;
    const itemId = `${source}:entry`;
    const offerId = `${source}:offer:current`;

    it('registers for signup with a localized template and keeps write tools off', () => {
      expect(DOMAIN_PACKS.get(`${pack.key}@1`)).toBe(pack);
      expect(packByKey(pack.key)).toBe(pack);
      expect(SIGNUP_PACK_KEYS).toContain(pack.key);
      expect(
        pack.slots
          .filter((slot) => slot.requiredFor.includes('search'))
          .map((slot) => slot.key),
      ).toEqual([primary]);
      expect(pack.actions).toEqual([]);
      expect(pack.tools).not.toContain('book_slot');
      expect(pack.tools).not.toContain('find_slots');
      const template = pack.crmTemplate!;
      expect(template.leadFields.map((field) => field.key)).toEqual(
        pack.slots.map((slot) => slot.key),
      );
      for (const locale of pack.locales) {
        expect(pack.capabilities[locale]).toBeTruthy();
        expect(template.pipelineName[locale]).toBeTruthy();
        for (const field of template.leadFields)
          expect(field.label[locale]).toBeTruthy();
      }
    });

    it('uses the product need and real contact evidence to score a lead', () => {
      const score = scoreLead(pack.leadScoring!, {
        slots: { [primary]: 'Atlas' },
        intent: 'booking_interest',
        hasPhone: true,
        offerShown: false,
        quoteShown: false,
      });
      expect(score.level).toBe('HOT');
      expect(score.reasonCodes).toEqual([
        'NEED_IDENTIFIED',
        'PURCHASE_INTEREST',
        'PHONE_AVAILABLE',
      ]);
      if (pack !== HOME_APPLIANCES_PACK)
        expect(extractionSystemPrompt(pack, INITIAL_LOCALE_PACKS)).toContain(
          '(human_request)',
        );
    });

    describe.each(locales)('$id', (locale) => {
      function turn(
        text: string,
        intent: Intent,
        slots: Record<string, string> = {},
        steps: ScriptStep[] = [],
      ): ReturnType<typeof runTurn> {
        return runTurn({
          pack,
          text,
          input: { conversationLocale: locale.id },
          connector: new MockConnector(
            { tenantId: 'tenant-eval', connectorKey: 'mock' },
            {
              sourceSystem: source,
              createLead: false,
              items: [
                {
                  sourceEntityId: 'entry',
                  itemType: 'item',
                  title,
                  attributes: {},
                  offers: [
                    {
                      sourceEntityId: 'current',
                      price: { amount: '250.00', currency: 'USD' },
                      pricingBasis: 'PER_UNIT',
                      availabilityStatus: 'AVAILABLE',
                      attributes: {},
                    },
                  ],
                },
              ],
            },
          ),
          provider: new ScriptedLlmProvider([
            extraction(slots, intent, locale.language, locale.script, pack),
            ...steps,
          ]),
        });
      }

      it('asks the sector-specific question without searching an empty request', async () => {
        const { result } = await turn(locale.hello, 'greeting');
        expect(result.locale).toBe(locale.id);
        expect(result).toMatchObject({
          outcome: 'ASKED_SLOT',
          askedSlot: primary,
          tools: [],
        });
        expect(result.reply).toContain(pack.slots[0]?.questions[locale.id]);
      });

      it('uses the catalog and collects preferences separately from the title', async () => {
        const [key, values] = preference;
        const value = values[locales.indexOf(locale)]!;
        const { result } = await turn(
          `${locale.find} ${value}`,
          'search',
          { [primary]: 'Atlas', [key]: value },
          [{ kind: 'tools', text: locale.reply }],
        );
        expect(result).toMatchObject({
          locale: locale.id,
          outcome: 'ANSWERED',
        });
        expect(result.reply).toContain(title);
        expect(String(result.slots[key]?.value)).toBe(value);
      });

      it('does not require preferences to answer with a verified quote', async () => {
        const { result } = await turn(
          locale.price,
          'price',
          { [primary]: 'Atlas' },
          [
            {
              kind: 'tools',
              toolCalls: [{ name: 'list_offers', input: { itemId } }],
            },
            {
              kind: 'tools',
              toolCalls: [{ name: 'get_quote', input: { offerId } }],
            },
            { kind: 'tools', text: locale.quote },
          ],
        );
        expect(
          result.outcome,
          JSON.stringify({
            handover: result.handover,
            tools: result.tools,
            facts: result.facts.map(({ id, value }) => [id, value.kind]),
            violations: result.violations,
          }),
        ).toBe('ANSWERED');
        expect(result.reply).toMatch(/250/u);
        expect(
          result.facts.some(
            (fact) => fact.value.kind === 'price' && fact.value.confirmedQuote,
          ),
        ).toBe(true);
      });

      it('does not answer a price for an item outside the catalog', async () => {
        const { result } = await turn(locale.price, 'price', {
          [primary]: 'Not-in-catalog',
        });
        expect(result.outcome).toBe('NO_RESULTS');
        expect(result.reply).not.toMatch(/250/u);
      });

      it('blocks a model draft that invents a price', async () => {
        const draft = {
          kind: 'tools',
          text: locale.quote.replace('{{F4}}', '9999'),
        } as const;
        const { result } = await turn(
          locale.price,
          'price',
          { [primary]: 'Atlas' },
          [draft, draft],
        );
        expect(result).toMatchObject({
          outcome: 'HANDOVER',
          handover: 'GUARDRAIL',
        });
        expect(result.reply).not.toContain('9999');
      });

      it.each([
        ['human_request', 'CUSTOMER_REQUEST'],
        ['negotiation', 'NEGOTIATION'],
        ['regulated_info', 'LEGAL_UNVERIFIED'],
      ] as const)('hands over %s', async (intent, handover) => {
        const { result } = await turn(locale.operator, intent);
        expect(result).toMatchObject({ outcome: 'HANDOVER', handover });
      });
    });
  });
}
