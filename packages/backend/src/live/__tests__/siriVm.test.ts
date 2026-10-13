/** SIRI-VM, XML and JSON: positions, lines and times read; incomplete vehicles refused. */
import { describe, expect, it } from 'bun:test';
import { normaliseSiriVm, parseSiriVmJson, parseSiriVmXml } from '../adapters/siriVm';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0">
  <ServiceDelivery>
    <VehicleMonitoringDelivery version="2.0">
      <VehicleActivity>
        <RecordedAtTime>2026-10-12T20:00:00+02:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>RUT:Line:31</LineRef>
          <PublishedLineName>31</PublishedLineName>
          <VehicleLocation><Longitude>10.7522</Longitude><Latitude>59.9139</Latitude></VehicleLocation>
          <Bearing>182.5</Bearing>
          <VehicleRef>RUT:Vehicle:101</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
      <VehicleActivity>
        <RecordedAtTime>2026-10-12T20:00:05+02:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>RUT:Line:37</LineRef>
          <VehicleRef>RUT:Vehicle:202</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
    </VehicleMonitoringDelivery>
  </ServiceDelivery>
</Siri>`;

const OPTIONS = {
  sourceId: 'oslo-test',
  operator: 'Test',
  coverage: { west: 10, south: 59, east: 11.5, north: 60.5 },
  defaultMode: 'bus' as const,
};
const NOW = Date.parse('2026-10-12T18:00:30Z');

describe('SIRI-VM', () => {
  it('reads XML vehicle activities and refuses one without a position', () => {
    const vehicles = parseSiriVmXml(XML);
    expect(vehicles).toHaveLength(2);
    const result = normaliseSiriVm(OPTIONS, vehicles, NOW);
    expect(result.rejected).toBe(1);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      id: 'oslo-test:RUT:Vehicle:101',
      line: '31',
      headingDegrees: 182.5,
      position: { latitude: 59.9139, longitude: 10.7522 },
      observedAt: '2026-10-12T18:00:00.000Z',
      positionBasis: 'reported',
    });
  });

  it('reads the JSON rendering the same way', () => {
    const json = {
      Siri: {
        ServiceDelivery: {
          VehicleMonitoringDelivery: [
            {
              VehicleActivity: [
                {
                  RecordedAtTime: '2026-10-12T18:00:10Z',
                  MonitoredVehicleJourney: {
                    LineRef: { value: 'L5' },
                    VehicleRef: { value: 'V9' },
                    VehicleLocation: { Latitude: 59.95, Longitude: 10.8 },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const result = normaliseSiriVm(OPTIONS, parseSiriVmJson(json), NOW);
    expect(result.entities.map((e) => e.kind === 'transit' && e.line)).toEqual(['L5']);
  });
});
