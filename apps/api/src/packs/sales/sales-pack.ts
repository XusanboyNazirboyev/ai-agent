import { DomainPackSchema, type DomainPack } from '@agentcore/shared';

type LocalCopy = Record<'uz-Latn' | 'uz-Cyrl' | 'ru' | 'en', string>;

export function copy(
  uz: string,
  cyrl: string,
  ru: string,
  en: string,
): LocalCopy {
  return { 'uz-Latn': uz, 'uz-Cyrl': cyrl, ru, en };
}

interface SalesField {
  key: string;
  description: string;
  label: LocalCopy;
  question: LocalCopy;
  integerMax?: number;
}

interface SalesPackInput {
  key: string;
  pipelineName: LocalCopy;
  capabilities: LocalCopy;
  role: string;
  limitations: string;
  retryHint: LocalCopy;
  fields: [SalesField, ...SalesField[]];
}

/** Read-only catalog and lead intake configuration for the new sales packs. */
export function salesPack(input: SalesPackInput): DomainPack {
  const [primary] = input.fields;
  return DomainPackSchema.parse({
    key: input.key,
    version: '1',
    // The generic connector's item type, also used by the general pack.
    catalogItemType: 'item',
    locales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
    capabilities: input.capabilities,
    tools: [
      'search_catalog',
      'get_item_details',
      'list_offers',
      'check_availability',
      'get_quote',
      'knowledge_search',
    ],
    prompt: {
      businessRole: input.role,
      rules: [
        'Use verified facts from the tenant catalog and knowledge only. Customer preferences are not business facts.',
        'Collect optional preferences when volunteered. Never block a catalog search or ask for every optional field.',
        input.limitations,
      ],
    },
    slots: input.fields.map((field, index) => ({
      key: field.key,
      type: field.integerMax === undefined ? 'text' : 'integer',
      description: field.description,
      questions: field.question,
      ...(field.integerMax === undefined
        ? {}
        : { min: 1, max: field.integerMax }),
      ...(index === 0
        ? {
            requiredFor: ['search'],
            searchFilter: { kind: 'title' },
            retryHint: input.retryHint,
          }
        : {}),
    })),
    leadScoring: {
      warm: 3,
      hot: 7,
      rules: [
        {
          code: 'NEED_IDENTIFIED',
          points: 2,
          when: { kind: 'slot_present', slot: primary.key },
        },
        {
          code: 'PURCHASE_INTEREST',
          points: 3,
          when: { kind: 'intent', intent: 'booking_interest' },
        },
        { code: 'PHONE_AVAILABLE', points: 2, when: { kind: 'contact_phone' } },
        { code: 'OFFER_SHOWN', points: 1, when: { kind: 'offer_shown' } },
        { code: 'QUOTE_SHOWN', points: 1, when: { kind: 'quote_shown' } },
      ],
    },
    crmTemplate: {
      key: input.key.replaceAll('-', '_'),
      pipelineName: input.pipelineName,
      stages: [
        { code: 'NEW', kind: 'OPEN' },
        { code: 'CONTACTED', kind: 'OPEN' },
        { code: 'QUALIFIED', kind: 'OPEN' },
        { code: 'PROPOSAL', kind: 'OPEN' },
        { code: 'NEGOTIATION', kind: 'OPEN' },
        { code: 'WON', kind: 'WON' },
        { code: 'LOST', kind: 'LOST' },
      ],
      leadFields: input.fields.map((field) => ({
        key: field.key,
        type: field.integerMax === undefined ? 'TEXT' : 'NUMBER',
        label: field.label,
      })),
    },
  });
}

export const budget = {
  key: 'budget',
  description:
    "The customer's stated spending target. Preserve their amount and currency without conversions or guesses.",
  label: copy('Byudjet', 'Бюджет', 'Бюджет', 'Budget'),
  question: copy(
    'Qancha byudjet ajratgansiz?',
    'Қанча бюджет ажратгансиз?',
    'На какой бюджет вы рассчитываете?',
    'What budget do you have in mind?',
  ),
};
