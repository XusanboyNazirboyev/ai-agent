/**
 * Suggests which column of an uploaded price list holds which canonical field
 * (ADR 064 decision 2). Only a suggestion: the admin confirms or corrects it
 * on the mapping screen before anything is saved.
 */

export const FIELD_KEYS = [
  'code',
  'title',
  'destination',
  'hotel',
  'stars',
  'nights',
  'meal',
  'room',
  'departureDate',
  'departureCity',
  'price',
  'currency',
  'seats',
  'flight',
  'notes',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** Field -> index of the column in the header row. */
export type ColumnMapping = Partial<Record<FieldKey, number>>;

/** Header names in en, ru and uz-Latn, squashed (see `squashHeader`). */
const SYNONYMS: Readonly<Record<FieldKey, readonly string[]>> = {
  code: ['code', 'id', 'sku', 'tourcode', 'offercode', 'код', 'артикул', 'kod'],
  title: [
    'title',
    'name',
    'tour',
    'tourname',
    'package',
    'название',
    'тур',
    'nomi',
    'turnomi',
  ],
  destination: [
    'destination',
    'country',
    'direction',
    'resort',
    'направление',
    'страна',
    'курорт',
    'yonalish',
    'davlat',
  ],
  hotel: [
    'hotel',
    'accommodation',
    'отель',
    'гостиница',
    'mehmonxona',
    'mehmonxonanomi',
  ],
  stars: [
    'stars',
    'hotelcategory',
    'звезд',
    'звёзды',
    'категория',
    'yulduz',
    'yulduzlar',
  ],
  nights: [
    'nights',
    'duration',
    'ночей',
    'ночи',
    'дней',
    'tun',
    'tunlar',
    'davomiyligi',
  ],
  meal: ['meal', 'mealplan', 'board', 'питание', 'ovqat', 'ovqatlanish'],
  room: [
    'room',
    'roomtype',
    'occupancy',
    'номер',
    'типномера',
    'размещение',
    'xona',
    'xonaturi',
  ],
  departureDate: [
    'departuredate',
    'date',
    'datefrom',
    'checkin',
    'startdate',
    'дата',
    'датавылета',
    'датазаезда',
    'заезд',
    'вылет',
    'sana',
    'jonashsanasi',
    'boshlanishsanasi',
  ],
  departureCity: [
    'departurecity',
    'from',
    'origin',
    'fromcity',
    'городвылета',
    'вылетиз',
    'откуда',
    'qaysishahardan',
    'uchishshahri',
    'jonashshahri',
  ],
  price: [
    'price',
    'priceperperson',
    'cost',
    'rate',
    'цена',
    'стоимость',
    'ценазачеловека',
    'narx',
    'narxi',
    'kishiganarx',
  ],
  currency: ['currency', 'cur', 'валюта', 'valyuta'],
  seats: [
    'seats',
    'seatsleft',
    'places',
    'allotment',
    'мест',
    'места',
    'осталосьмест',
    'joy',
    'joylar',
    'boshjoylar',
  ],
  flight: [
    'flight',
    'flightincluded',
    'airfare',
    'перелет',
    'перелёт',
    'авиа',
    'aviachipta',
    'parvoz',
  ],
  notes: [
    'notes',
    'note',
    'comment',
    'remarks',
    'примечание',
    'комментарий',
    'izoh',
    'eslatma',
  ],
};

/** Lower case, no spaces or punctuation, `ё` as `е`: `Price per person` -> `priceperperson`. */
export function squashHeader(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/ё/gu, 'е')
      // Apostrophes of every kind (o', oʻ, o’) are dropped: yo'nalish = yonalish.
      .replace(/['’‘`ʻʼʹ′]/gu, '')
      .replace(/[^\p{L}\p{N}]/gu, '')
  );
}

interface Candidate {
  readonly field: FieldKey;
  readonly index: number;
  readonly score: number;
}

/**
 * Exact matches beat partial ones; longer names beat shorter ones; each field
 * and each column is used once. Short names (under four letters) only count
 * as an exact match, so `Seats left` is seats but `Hotel code` is not a code.
 */
export function suggestMapping(header: readonly string[]): ColumnMapping {
  const squashed = header.map(squashHeader);
  const candidates: Candidate[] = [];
  for (const field of FIELD_KEYS)
    for (const name of SYNONYMS[field].map(squashHeader)) {
      squashed.forEach((column, index) => {
        if (column === '') return;
        if (column === name)
          candidates.push({ field, index, score: 1000 + name.length });
        else if (name.length >= 4 && column.includes(name))
          candidates.push({ field, index, score: 100 + name.length });
      });
    }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const mapping: ColumnMapping = {};
  const usedColumns = new Set<number>();
  for (const { field, index } of candidates) {
    if (mapping[field] !== undefined || usedColumns.has(index)) continue;
    mapping[field] = index;
    usedColumns.add(index);
  }
  return mapping;
}

/** Fields a price list must map to be importable. */
export function missingRequiredFields(mapping: ColumnMapping): FieldKey[] {
  const missing: FieldKey[] = [];
  if (mapping.price === undefined) missing.push('price');
  if (
    mapping.title === undefined &&
    mapping.destination === undefined &&
    mapping.hotel === undefined
  )
    missing.push('title');
  return missing;
}
