/**
 * Display names of channel types. A type missing here would otherwise show as
 * its raw identifier ("instagram"), which is what the Bot page did for an
 * Instagram account (audit F1).
 */
const NAMES: Readonly<Record<string, string>> = {
  telegram: 'Telegram',
  instagram: 'Instagram',
  facebook: 'Messenger',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
  // ADR 061: the internal channel of a lead added by hand.
  manual: 'Manual',
};

export function channelName(channelType: string): string {
  return NAMES[channelType] ?? channelType;
}
