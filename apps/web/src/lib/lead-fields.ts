/**
 * The owner decided (2026-11-13) that a lead needs no amount in the product:
 * the field stays in the API and the database (ADR 057, additive), only the
 * web hides it. Set to true to show the amount again: card, list, column
 * totals, lead panel and the add-lead dialog all read this one flag.
 */
export const LEAD_AMOUNT_ENABLED = false;
