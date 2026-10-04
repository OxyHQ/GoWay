/**
 * The shared SigV4 signer, against AWS's own published test vectors.
 *
 * A signer can be wrong in ways that still produce a well-formed header — a
 * header sorted case-sensitively, a query encoded with `encodeURIComponent`, a
 * region in the wrong slot of the scope — and every one of those is an opaque
 * 403 in production. The vectors below come from the AWS Signature Version 4
 * test suite (`get-vanilla`, `get-vanilla-query-order-key-case`), so agreement
 * with them is agreement with AWS rather than with this file's own reading.
 */

import { describe, expect, it } from 'bun:test';
import { encodeKey, encodeRfc3986, sha256Hex, signRequest } from '../sigv4';

const SUITE = {
  region: 'us-east-1',
  service: 'service',
  now: new Date('2015-08-30T12:36:00.000Z'),
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
};

describe('signRequest', () => {
  it('matches the AWS get-vanilla vector', () => {
    const headers = signRequest({ ...SUITE, method: 'GET', url: 'https://example.amazonaws.com/', includeContentSha256: false });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('matches the AWS query-order vector: parameters are canonicalized, not sent order', () => {
    const headers = signRequest({
      ...SUITE, method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1', includeContentSha256: false,
    });
    expect(headers.authorization).toEndWith('Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
  });

  it('signs the real payload hash and the session token, and covers every returned header', () => {
    const headers = signRequest({
      ...SUITE,
      credentials: { ...SUITE.credentials, sessionToken: 'token' },
      method: 'POST', url: 'https://sqs.eu-west-1.amazonaws.com/', body: '{"a":1}',
      headers: { 'content-type': 'application/x-amz-json-1.0', 'X-Amz-Target': 'AmazonSQS.SendMessage' },
    });
    expect(headers['x-amz-content-sha256']).toBe(sha256Hex('{"a":1}'));
    expect(headers['x-amz-security-token']).toBe('token');
    expect(headers.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-target,',
    );
    const other = signRequest({
      ...SUITE, method: 'POST', url: 'https://sqs.eu-west-1.amazonaws.com/', body: '{"a":2}',
      headers: { 'content-type': 'application/x-amz-json-1.0', 'X-Amz-Target': 'AmazonSQS.SendMessage' },
    });
    expect(other.authorization).not.toBe(headers.authorization);
  });
});

describe('encoding', () => {
  it('encodes the characters encodeURIComponent leaves alone, segment by segment', () => {
    expect(encodeRfc3986("a!'()*")).toBe('a%21%27%28%29%2A');
    expect(encodeKey('scenes/a b/(x).spz')).toBe('scenes/a%20b/%28x%29.spz');
  });
});
