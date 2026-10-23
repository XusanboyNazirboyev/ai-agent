import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

const {
  assertAddressesArePublic,
  isBlockedHostname,
  isBlockedIpLiteral,
  normalizeResolvedAddresses,
  OutboundUrlPolicy,
  parseLoopbackExemptions,
  resolveHostnameAddresses,
  validateOutboundUrl,
} = await import('./ssrf-protection.js');

const strict = { policy: OutboundUrlPolicy.STRICT };

describe('restricted address ranges', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.0.8',
    '192.0.2.10',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    // Alternative IPv4 encodings of loopback.
    '2130706433',
    '0x7f000001',
    '127.1',
    '0177.0.0.1',
  ])('blocks IPv4 %s', (address) => {
    expect(isBlockedIpLiteral(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1'])(
    'allows public IPv4 %s',
    (address) => {
      expect(isBlockedIpLiteral(address)).toBe(false);
    },
  );

  it.each([
    '::1',
    '::',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '::ffff:0:127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:a00:1::1',
    '100::1',
    '2001::1',
    '2001:db8::1',
    'fe80::1',
    'fec0::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    'ff05::2',
    'ff0e::1',
    'zz::not-an-address',
  ])('blocks IPv6 %s', (address) => {
    expect(isBlockedIpLiteral(address)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111',
    '2a00:1450:4001:80e::200e',
    '64:ff9b::808:808',
    '2002:808:808::1',
    '::ffff:8.8.8.8',
  ])('allows public IPv6 %s', (address) => {
    expect(isBlockedIpLiteral(address)).toBe(false);
  });

  it.each([
    'localhost',
    'LOCALHOST.',
    'api.localhost',
    'printer.local',
    'db.internal',
    'metadata.google.internal',
    'metadata.azure.com',
  ])('blocks restricted hostname %s', (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });
});

describe('validateOutboundUrl', () => {
  it('accepts a public https URL', () => {
    expect(validateOutboundUrl('https://crm.example.com/api', strict)).toEqual({
      href: 'https://crm.example.com/api',
      hostname: 'crm.example.com',
      protocol: 'https:',
    });
  });

  it.each([
    ['ftp://crm.example.com/', 'CONNECTOR_INVALID_PROTOCOL'],
    ['file:///etc/passwd', 'CONNECTOR_INVALID_PROTOCOL'],
    ['gopher://crm.example.com/', 'CONNECTOR_INVALID_PROTOCOL'],
    ['not a url', 'CONNECTOR_INVALID_URL'],
    ['https://user:secret@crm.example.com/', 'CONNECTOR_URL_CREDENTIALS'],
    ['http://localhost:4000/', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['http://127.0.0.1/', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['http://2130706433/', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['http://[::1]:8080/', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['http://[::ffff:a9fe:a9fe]/', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['http://169.254.169.254/latest/meta-data', 'CONNECTOR_SSRF_BLOCKED_HOST'],
    ['https://metadata.google.internal/', 'CONNECTOR_SSRF_BLOCKED_HOST'],
  ])('rejects %s with %s', (url, code) => {
    expect(() => validateOutboundUrl(url, strict)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('never echoes embedded credentials in the error message', () => {
    try {
      validateOutboundUrl('https://user:secret@crm.example.com/', strict);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret');
    }
  });

  it('permits loopback hostnames only under the permissive development policy', () => {
    expect(
      validateOutboundUrl('http://localhost:4000/', {
        policy: OutboundUrlPolicy.PERMISSIVE,
      }).hostname,
    ).toBe('localhost');
  });
});

describe('resolver answer validation', () => {
  it('rejects an empty answer', () => {
    expect(() => normalizeResolvedAddresses('crm.example.com', [])).toThrow(
      expect.objectContaining({ code: 'CONNECTOR_DNS_EMPTY' }),
    );
  });

  it.each([
    [{ address: '93.184.216.34', family: 6 }],
    [{ address: '2606:4700::1', family: 4 }],
    [{ address: '93.184.216.34', family: 5 }],
    [{ address: 'crm.example.com', family: 4 }],
    [{ address: 42, family: 4 }],
  ])('rejects malformed or family-mismatched entry %o', (entry) => {
    expect(() =>
      normalizeResolvedAddresses('crm.example.com', [entry]),
    ).toThrow(
      expect.objectContaining({ code: 'CONNECTOR_DNS_UNEXPECTED_ADDRESS' }),
    );
  });

  it('rejects a host when any answer is restricted (rebinding setup)', () => {
    expect(() =>
      assertAddressesArePublic(
        'crm.example.com',
        [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.7', family: 4 },
        ],
        strict,
      ),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' }));
  });

  it('skips only exact exempted loopback addresses', () => {
    const exemptAddresses = parseLoopbackExemptions(['127.0.0.1']);
    expect(() =>
      assertAddressesArePublic(
        'crm.test',
        [{ address: '127.0.0.1', family: 4 }],
        { ...strict, exemptAddresses },
      ),
    ).not.toThrow();
    expect(() =>
      assertAddressesArePublic(
        'crm.test',
        [{ address: '127.0.0.2', family: 4 }],
        { ...strict, exemptAddresses },
      ),
    ).toThrow(expect.objectContaining({ code: 'CONNECTOR_SSRF_BLOCKED_HOST' }));
  });

  it.each(['10.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', 'fe80::1', 'x'])(
    'refuses to exempt non-loopback address %s',
    (address) => {
      expect(() => parseLoopbackExemptions([address])).toThrow(
        expect.objectContaining({ code: 'CONNECTOR_INVALID_SSRF_EXEMPTION' }),
      );
    },
  );
});

describe('resolveHostnameAddresses', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('returns IP literals without consulting DNS', async () => {
    await expect(resolveHostnameAddresses('[::1]')).resolves.toEqual([
      { address: '::1', family: 6 },
    ]);
    await expect(resolveHostnameAddresses('93.184.216.34')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('returns every validated address from DNS', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25C8:1946', family: 6 },
    ]);
    await expect(resolveHostnameAddresses('crm.example.com')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    expect(lookupMock).toHaveBeenCalledWith('crm.example.com', {
      all: true,
      order: 'verbatim',
    });
  });

  it('maps resolver failures to a retryable DNS error', async () => {
    lookupMock.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    await expect(resolveHostnameAddresses('crm.example.com')).rejects.toEqual(
      expect.objectContaining({
        code: 'CONNECTOR_DNS_FAILURE',
        retryable: true,
      }),
    );
  });

  it('rejects an empty or unexpected DNS answer', async () => {
    lookupMock.mockResolvedValueOnce([]);
    await expect(resolveHostnameAddresses('crm.example.com')).rejects.toEqual(
      expect.objectContaining({ code: 'CONNECTOR_DNS_EMPTY' }),
    );
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 0 }]);
    await expect(resolveHostnameAddresses('crm.example.com')).rejects.toEqual(
      expect.objectContaining({ code: 'CONNECTOR_DNS_UNEXPECTED_ADDRESS' }),
    );
  });
});
