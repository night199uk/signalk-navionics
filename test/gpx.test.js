'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gpx = require('../src/gpx');

const ROUTE = `<?xml version="1.0" encoding="UTF-8" ?>
<gpx xmlns:nvx="https://www.navionics.com" xmlns="http://www.topografix.com/GPX/1/1">
\t<rte>
\t\t<name>Zulu Route</name>
\t\t<time>2026-01-01T00:00:00Z</time>
\t\t<extensions>
\t\t\t<raymarine:GUID>11111111-1111-4111-8111-111111111111</raymarine:GUID>
\t\t</extensions>
\t\t<rtept lat="10.000000" lon="-20.000000">
\t\t\t<name>P1</name>
\t\t\t<time>2026-01-01T00:00:01Z</time>
\t\t\t<extensions>
\t\t\t\t<raymarine:GUID>22222222-2222-4222-8222-222222222222</raymarine:GUID>
\t\t\t</extensions>
\t\t</rtept>
\t\t<rtept lat="10.100000" lon="-20.100000">
\t\t\t<name>P2</name>
\t\t\t<time>2026-01-01T00:00:01Z</time>
\t\t\t<extensions>
\t\t\t\t<raymarine:GUID>33333333-3333-4333-8333-333333333333</raymarine:GUID>
\t\t\t</extensions>
\t\t</rtept>
\t</rte>
</gpx>`;

const WAYPOINT = `<?xml version="1.0" encoding="UTF-8" ?>
<gpx xmlns:nvx="https://www.navionics.com" xmlns="http://www.topografix.com/GPX/1/1">
\t<wpt lat="11.000000" lon="-21.000000">
\t\t<name>Alpha Marker</name>
\t\t<time>2026-01-01T00:00:02Z</time>
\t\t<extensions>
\t\t\t<raymarine:GUID>44444444-4444-4444-8444-444444444444</raymarine:GUID>
\t\t</extensions>
\t</wpt>
</gpx>`;

test('parses Navionics route GPX', () => {
  const parsed = gpx.parseGpx(ROUTE);
  assert.equal(parsed.routes.length, 1);
  const route = parsed.routes[0];
  assert.equal(route.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(route.name, 'Zulu Route');
  assert.equal(route.points.length, 2);
  assert.deepEqual(route.points[0], {
    lat: 10.000000,
    lon: -20.000000,
    name: 'P1',
    description: '',
    time: '2026-01-01T00:00:01Z',
    guid: '22222222-2222-4222-8222-222222222222',
  });
});

test('parses Navionics waypoint GPX', () => {
  const parsed = gpx.parseGpx(WAYPOINT);
  assert.equal(parsed.waypoints.length, 1);
  assert.deepEqual(parsed.waypoints[0], {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Alpha Marker',
    description: '',
    time: '2026-01-01T00:00:02Z',
    lat: 11.000000,
    lon: -21.000000,
  });
});

test('round-trips route resource to GPX', () => {
  const parsed = gpx.parseGpx(ROUTE);
  const resource = gpx.routeToResource(parsed.routes[0]);
  assert.deepEqual(resource.feature.geometry.coordinates, [
    [-20.000000, 10.000000],
    [-20.100000, 10.100000],
  ]);
  const out = gpx.routeGpx(parsed.routes[0].id, resource);
  const again = gpx.parseGpx(out);
  assert.equal(again.routes.length, 1);
  assert.equal(again.routes[0].id, parsed.routes[0].id);
  assert.equal(again.routes[0].points.length, 2);
  assert.equal(again.routes[0].points[0].guid, parsed.routes[0].points[0].guid);
});

test('round-trips waypoint resource to GPX', () => {
  const parsed = gpx.parseGpx(WAYPOINT);
  const resource = gpx.waypointToResource(parsed.waypoints[0]);
  assert.deepEqual(resource.feature.geometry.coordinates, [-21.000000, 11.000000]);
  const again = gpx.parseGpx(gpx.waypointGpx(parsed.waypoints[0].id, resource));
  assert.equal(again.waypoints.length, 1);
  assert.equal(again.waypoints[0].id, parsed.waypoints[0].id);
});

test('builds and parses the Navionics archive index', () => {
  const route = gpx.routeToResource(gpx.parseGpx(ROUTE).routes[0]);
  const waypoint = gpx.waypointToResource(gpx.parseGpx(WAYPOINT).waypoints[0]);
  const xml = gpx.buildArchive({
    '11111111-1111-4111-8111-111111111111': route,
  }, {
    '44444444-4444-4444-8444-444444444444': waypoint,
  });
  const entries = gpx.parseArchive(xml);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.type]), [
    ['Alpha Marker', '15'],
    ['Zulu Route', '14'],
  ]);
});

test('truncates archive filenames to 15 characters', () => {
  assert.equal(gpx.archiveName('Exact Fifteen!!'), 'Exact Fifteen!!');
  assert.equal(gpx.archiveName('This name is much too long'), 'This name is mu');
  assert.equal(gpx.fileName('Zulu Route'), 'Zulu Route.gpx');
});


test('generates stable v4 ids when Navionics GPX has no GUID', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<gpx><wpt lat="12.000000" lon="-22.000000"><name>Unnamed Marker</name><time>2026-01-01T00:00:04Z</time></wpt></gpx>`;
  const first = gpx.parseGpx(xml).waypoints[0];
  const second = gpx.parseGpx(xml).waypoints[0];
  assert.equal(first.id, second.id);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});


test('preserves trailing spaces in Navionics names', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<gpx><wpt lat="13.000000" lon="-23.000000"><name>Trailing Space </name><time>2026-01-01T00:00:03Z</time></wpt></gpx>`;
  const waypoint = gpx.parseGpx(xml).waypoints[0];
  assert.equal(waypoint.name, 'Trailing Space ');
  const resource = gpx.waypointToResource(waypoint);
  assert.equal(resource.name, 'Trailing Space ');
  assert.equal(gpx.archiveName(resource.name), 'Trailing Space ');
});
