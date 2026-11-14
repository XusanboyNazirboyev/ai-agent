/**
 * What the customer was shown, in words an operator understands. The API
 * stores the verified facts of the reply (title, price, availability, seats,
 * date) with their provenance; the inbox used to print the raw ids. This reads
 * the stored JSON defensively (it is data, never trusted) and keeps the
 * technical references apart for the "details" fold.
 */

export interface ShownOfferView {
  title: string | null;
  price: {
    /** The amount as the source wrote it (a decimal string, never recomputed). */
    amount: string;
    currency: string;
    basis: 'PER_PERSON' | 'PER_NIGHT' | 'PER_UNIT' | 'TOTAL' | null;
    /** A live quote was confirmed with the source before it was shown. */
    confirmed: boolean;
  } | null;
  availability: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN' | null;
  seats: number | null;
  startsAt: string | null;
  checkedAt: string | null;
  /** Internal references, for the details fold only. */
  technical: string[];
}

const BASES = ['PER_PERSON', 'PER_NIGHT', 'PER_UNIT', 'TOTAL'] as const;
const STATUSES = ['AVAILABLE', 'LIMITED', 'SOLD_OUT', 'UNKNOWN'] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export function describeShownOffer(
  offerRef: string,
  facts: unknown,
): ShownOfferView {
  const view: ShownOfferView = {
    title: null,
    price: null,
    availability: null,
    seats: null,
    startsAt: null,
    checkedAt: null,
    technical: [offerRef],
  };
  if (!Array.isArray(facts)) return view;
  for (const entry of facts.slice(0, 40)) {
    const fact = record(entry);
    const value = record(fact?.value);
    const provenance = record(fact?.provenance);
    if (!fact || !value) continue;
    const id = text(fact.id);
    if (id) view.technical.push(id);
    const source = text(provenance?.sourceSystem);
    if (source && !view.technical.includes(source)) view.technical.push(source);
    const checked = text(provenance?.retrievedAt);
    if (checked && (!view.checkedAt || checked > view.checkedAt))
      view.checkedAt = checked;
    switch (value.kind) {
      case 'title':
        view.title ??= text(value.text);
        break;
      case 'price': {
        const money = record(value.money);
        const amount = text(money?.amount);
        const currency = text(money?.currency);
        if (!amount || !currency) break;
        const basis = BASES.find((b) => b === value.pricingBasis) ?? null;
        const confirmed = value.confirmedQuote === true;
        // A confirmed quote wins over a listed price.
        if (!view.price || (confirmed && !view.price.confirmed))
          view.price = { amount, currency, basis, confirmed };
        break;
      }
      case 'availability':
        view.availability =
          STATUSES.find((s) => s === value.status) ?? view.availability;
        break;
      case 'seats':
        if (typeof value.count === 'number' && value.count >= 0)
          view.seats = Math.floor(value.count);
        break;
      case 'datetime':
        view.startsAt ??= text(value.iso);
        break;
      default:
        break;
    }
  }
  return view;
}

/** "1250000.50" -> "1 250 000.50": digits are grouped as text, never as a float. */
export function groupAmount(amount: string): string {
  const [whole = '', fraction] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
