import {
  restTransport,
  type Bitrix24Transport,
} from '../connectors/bitrix24/bitrix24-client.js';

/** A name that never resolves outside this transport. */
const FAKE_HOST = 'bitrix24-portal.invalid';

/**
 * Test only (BITRIX24_TEST_BASE_URL, refused in production by the
 * environment schema): the Bitrix24 check is sent to a local fake portal
 * instead of the portal in the URL, keeping the /rest/<user>/<code>/<method>
 * path. The hardened client blocks IP literals, so the request goes to a
 * fixed `.invalid` name that this transport alone resolves to the base's
 * loopback address, and plain http is exempt only for that address.
 */
export function bitrix24TestTransport(base: string): Bitrix24Transport {
  const target = new URL(base);
  const address = target.hostname;
  const http = restTransport({
    resolve: async () => [{ address, family: 4 }],
    exemptLoopbackAddresses: [address],
  });
  const port = target.port ? `:${target.port}` : '';
  return (url, body) =>
    http(`http://${FAKE_HOST}${port}${new URL(url).pathname}`, body);
}
