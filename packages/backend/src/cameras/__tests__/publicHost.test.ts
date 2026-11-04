import { describe, expect, it } from 'bun:test';
import { assertPublicUrl, isPrivateAddress } from '../publicHost';

describe('isPrivateAddress', () => {
  it('refuses loopback, private, link-local (cloud metadata), CGNAT and reserved IPv4', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ])
      expect({ address, private: isPrivateAddress(address) }).toEqual({ address, private: true });
  });

  it('accepts public IPv4, including the edges of the private ranges', () => {
    for (const address of [
      '8.8.8.8',
      '172.15.255.255',
      '172.32.0.1',
      '100.63.255.255',
      '193.166.1.1',
    ])
      expect({ address, private: isPrivateAddress(address) }).toEqual({ address, private: false });
  });

  it('refuses private IPv6, and an IPv4-mapped address by the IPv4 it wraps', () => {
    for (const address of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:10.0.0.1',
    ])
      expect({ address, private: isPrivateAddress(address) }).toEqual({ address, private: true });
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('refuses what is not an address at all', () => {
    expect(isPrivateAddress('example.org')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  const resolves = (addresses: string[]) => async () => addresses;

  it('accepts a host whose every address is public', async () => {
    await assertPublicUrl(new URL('https://cams.example.org/a.jpg'), resolves(['93.184.216.34']));
  });

  it('refuses a host that resolves to ANY private address (DNS pointing inward)', async () => {
    await expect(
      assertPublicUrl(
        new URL('https://cams.example.org/'),
        resolves(['93.184.216.34', '10.0.0.5']),
      ),
    ).rejects.toThrow('not a public address');
  });

  it('refuses a literal private address without resolving, and a bracketed IPv6 one', async () => {
    const never = async () => {
      throw new Error('should not resolve');
    };
    await expect(
      assertPublicUrl(new URL('http://169.254.169.254/latest'), never),
    ).rejects.toThrow();
    await expect(assertPublicUrl(new URL('http://[::1]:5432/'), never)).rejects.toThrow();
  });

  it('refuses other schemes, embedded credentials and a host that does not resolve', async () => {
    await expect(assertPublicUrl(new URL('file:///etc/passwd'), resolves([]))).rejects.toThrow(
      'http(s)',
    );
    await expect(
      assertPublicUrl(new URL('https://u:p@example.org/'), resolves(['8.8.8.8'])),
    ).rejects.toThrow('credentials');
    await expect(
      assertPublicUrl(new URL('https://nowhere.example/'), resolves([])),
    ).rejects.toThrow('does not resolve');
  });
});
