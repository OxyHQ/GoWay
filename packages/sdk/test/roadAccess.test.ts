import { describe, expect, it } from 'vitest';
import {
  accessLevel,
  accessOverrides,
  defaultRoadAccess,
  formatAccessOverrides,
  parseAccessOverrides,
  resolveRoadAccess,
  roadAccessOf,
} from '../src/roadAccess';

/** The one reader of OSM access tags: chains, defaults and the tile round trip. */
describe('road access', () => {
  it('lets a bus lane inside a road open it to buses and leave cars where access puts them', () => {
    const access = resolveRoadAccess('residential', { access: 'no', bus: 'designated' });
    expect(access.bus).toBe('designated');
    expect(access.car).toBe('no');
    expect(access.taxi).toBe('no');
  });

  it('reads the most specific key first and psv for both buses and taxis', () => {
    const tags = { motor_vehicle: 'no', psv: 'yes', taxi: 'no' };
    const access = resolveRoadAccess('tertiary', tags);
    expect(access.bus).toBe('yes');
    expect(access.taxi).toBe('no');
    expect(access.car).toBe('no');
    expect(resolveRoadAccess('tertiary', { motorcar: 'yes', motor_vehicle: 'no' }).car).toBe('yes');
  });

  it('keeps a destination-only road local, never through', () => {
    const access = resolveRoadAccess('service', { motor_vehicle: 'destination' });
    expect(accessLevel(access.car)).toBe('local');
    expect(accessLevel(defaultRoadAccess('living_street').car)).toBe('local');
    expect(accessLevel(resolveRoadAccess('residential', { access: 'customers' }).car)).toBe(
      'local',
    );
    expect(accessLevel(resolveRoadAccess('service', { access: 'private' }).car)).toBe('none');
  });

  it('refuses an unreadable value instead of guessing', () => {
    expect(resolveRoadAccess('residential', { access: 'sometimes' }).car).toBe('yes');
  });

  it('never lets a general ban stop an emergency vehicle', () => {
    expect(resolveRoadAccess('residential', { access: 'no' }).emergency).toBe('yes');
  });

  it('admits nobody on an unknown class and only people on a footway', () => {
    expect(defaultRoadAccess('proposed').car).toBe('no');
    const footway = defaultRoadAccess('footway');
    expect(footway.foot).toBe('yes');
    expect(footway.car).toBe('no');
    expect(footway.bicycle).toBe('no');
  });

  it('carries only the difference from the class default through a tile', () => {
    expect(accessOverrides('residential', resolveRoadAccess('residential', {}))).toEqual({});
    const access = resolveRoadAccess('residential', { motor_vehicle: 'no', bus: 'yes' });
    const overrides = accessOverrides('residential', access);
    expect(overrides.bus).toBeUndefined();
    const text = formatAccessOverrides(overrides);
    expect(text).toContain('car=no');
    expect(roadAccessOf('residential', parseAccessOverrides(text))).toEqual(access);
    expect(formatAccessOverrides({})).toBeUndefined();
  });

  it('drops an unknown user or value when reading a tile back', () => {
    expect(parseAccessOverrides('car=no;horse=yes;bus=maybe;bus=designated')).toEqual({
      car: 'no',
      bus: 'designated',
    });
  });
});
