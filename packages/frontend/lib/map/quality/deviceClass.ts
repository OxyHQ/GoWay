/**
 * Native: a tablet or a phone, as React Native reports it. The quality profile
 * is platform-neutral (`profile.ts`); this is only the device-class input to
 * it. The web fork is `deviceClass.web.ts`.
 */
import { Dimensions, Platform } from 'react-native';

import type { DeviceClass } from './profile';

export function currentDeviceClass(): DeviceClass {
  if (Platform.OS === 'ios' && Platform.isPad) return 'tablet';
  const { width, height } = Dimensions.get('screen');
  return Math.min(width, height) >= 600 ? 'tablet' : 'phone';
}
