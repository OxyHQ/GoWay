/**
 * The device locale as the app reads it, end to end into a label: what the
 * engine reports, the tag `deviceLocale()` passes on, and the label the SDK's
 * matcher picks for it. The whole tag travels — `zh-Hans-CN`, not `zh` — so a
 * script or region the matcher needs is never thrown away on the way.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { capabilityGroupLabel, capabilityValueLabel } from '@goway.to/sdk';

import { deviceLocale } from '../i18n';

const realDateTimeFormat = Intl.DateTimeFormat;

/** `Intl.DateTimeFormat().resolvedOptions().locale` answering `locale`. */
function reporting(locale: string): void {
  Object.defineProperty(Intl, 'DateTimeFormat', {
    configurable: true,
    writable: true,
    value: () => ({ resolvedOptions: () => ({ locale }) }),
  });
}

afterEach(() => {
  Object.defineProperty(Intl, 'DateTimeFormat', {
    configurable: true,
    writable: true,
    value: realDateTimeFormat,
  });
});

describe('deviceLocale', () => {
  test.each([
    ['zh-Hans-CN', 'zh-Hans-CN', '支付'],
    ['zh-CN', 'zh-CN', '支付'],
    ['zh-Hant-TW', 'zh-Hant-TW', '支付'],
    ['pt-BR', 'pt-BR', 'Pagamento'],
    ['pt-PT', 'pt-PT', 'Pagamento'],
    ['ca-ES', 'ca-ES', 'Pagament'],
    ['ar-SA-u-nu-arab', 'ar-SA', 'الدفع'],
    ['ja-JP-u-ca-japanese', 'ja-JP', '支払い'],
    ['zh-Hant-TW-u-nu-hanidec', 'zh-Hant-TW', '支付'],
    ['en-US-u-ca-gregory', 'en-US', 'Payment'],
    ['de-x-private', 'de', 'Zahlung'],
    ['en-US', 'en-US', 'Payment'],
  ])('passes %s on as %s, which reads %s', (reported, passed, label) => {
    reporting(reported);
    expect(deviceLocale()).toBe(passed);
    expect(capabilityGroupLabel('payment', deviceLocale())).toBe(label);
  });

  test('reads an enum value in the device language', () => {
    reporting('ca-ES');
    expect(capabilityValueLabel('food.cuisine', 'catalan', deviceLocale())).toBe('Catalana');
  });
});
