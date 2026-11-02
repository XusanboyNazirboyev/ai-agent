import {
  restTransport,
  type Bitrix24Transport,
} from '../connectors/bitrix24/bitrix24-client.js';

/**
 * Test only (BITRIX24_TEST_BASE_URL, refused in production by the
 * environment schema): the Bitrix24 check is sent to a local fake portal
 * instead of the portal in the URL, keeping the /rest/<user>/<code>/<method>
 * path. Loopback over http is allowed only for this exact local address.
 */
export function bitrix24TestTransport(base: string): Bitrix24Transport {
  const target = new URL(base);
  const http = restTransport({ exemptLoopbackAddresses: [target.hostname] });
  return (url, body) => {
    const original = new URL(url);
    return http(`${target.origin}${original.pathname}`, body);
  };
}
