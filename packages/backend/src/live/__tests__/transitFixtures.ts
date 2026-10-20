/**
 * A small timetable written the way an operator writes one (Europe/Madrid),
 * for the transit tests. The shapes the real feeds have and the code must
 * survive are all here: a station with two platforms and an entrance, a line
 * with only a long name, a trip with no headsign, a trip running past 24:00,
 * a stop time with no time, a no-boarding stop, a calendar exception.
 *
 * Service days: `WD` Monday to Friday, `SU` Sundays, from 2026-01-01 to
 * 2026-12-31; `WD` does not run on Thursday 2026-10-22 (`calendar_dates`).
 */

import { deflateRawSync } from 'node:zlib';
import type { ScheduleFiles } from '../transit/schedule';

export const AGENCY =
  'agency_id,agency_name,agency_url,agency_timezone\nA,Test Transit,https://transit.example,Europe/Madrid\n';

export const ROUTES = [
  'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color',
  'L1,L1,Plaça Test - Nord,3,112233,FFFFFF',
  // Only a long name; no colour: the badge must not invent one.
  'M1,,Línia Metro Un,1,,',
].join('\n');

export const STOPS = [
  'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
  'ST,Plaça Test,41.3900,2.1700,1,',
  'P1,Plaça Test (andana 1),41.3901,2.1701,0,ST',
  'P2,Plaça Test (andana 2),41.3899,2.1699,0,ST',
  'EN,Plaça Test entrada,41.3902,2.1702,2,ST',
  'NORD,Nord Terminal,41.4500,2.2200,0,',
  'FAR,Lluny,41.5000,2.3000,0,',
  'NOWHERE,Sense coordenades,,,0,',
].join('\n');

export const CALENDAR = [
  'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
  'WD,1,1,1,1,1,0,0,20260101,20261231',
  'SU,0,0,0,0,0,0,1,20260101,20261231',
].join('\n');

export const CALENDAR_DATES = ['service_id,date,exception_type', 'WD,20261022,2'].join('\n');

export const TRIPS = [
  'route_id,service_id,trip_id,trip_headsign',
  'L1,WD,T1,Nord Terminal',
  // No headsign: it ends at Nord Terminal.
  'L1,WD,T2,',
  'M1,SU,T3,Fora',
  // Leaves a few minutes after midnight, as "24:10:00" of the day before.
  'L1,WD,TN,Nord Terminal',
  // A trip nobody can board at P1 (pickup_type 1), and with no time at P2.
  'L1,WD,T4,Nord Terminal',
].join('\n');

export const STOP_TIMES = [
  'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type',
  'T1,12:00:00,12:00:00,P1,1,0',
  'T1,12:20:00,12:20:00,NORD,2,0',
  'T2,12:10:00,12:10:00,P2,1,0',
  'T2,12:30:00,12:30:00,NORD,2,0',
  'T3,09:00:00,09:00:00,P1,1,0',
  'T3,09:10:00,09:10:00,NORD,2,0',
  'TN,24:10:00,24:10:00,P1,1,0',
  'TN,24:40:00,24:40:00,NORD,2,0',
  'T4,13:00:00,13:00:00,P1,1,1',
  'T4,,,P2,2,0',
  'T4,13:30:00,13:30:00,NORD,3,0',
].join('\n');

export function scheduleFiles(overrides: Partial<ScheduleFiles> = {}): ScheduleFiles {
  return {
    agency: AGENCY,
    routes: ROUTES,
    trips: TRIPS,
    stops: STOPS,
    stopTimes: STOP_TIMES,
    calendar: CALENDAR,
    calendarDates: CALENDAR_DATES,
    ...overrides,
  };
}

/** A zip with deflated entries, built by hand. */
export function zip(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(Buffer.byteLength(text), 24);
    chunks.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralBytes, end]));
}

export function archiveFiles(): Record<string, string> {
  return {
    'agency.txt': AGENCY,
    'routes.txt': ROUTES,
    'trips.txt': TRIPS,
    'stops.txt': STOPS,
    'stop_times.txt': STOP_TIMES,
    'calendar.txt': CALENDAR,
    'calendar_dates.txt': CALENDAR_DATES,
  };
}
