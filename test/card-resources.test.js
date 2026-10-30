'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CardResourceProvider } = require('../src/card-resources');

const ROUTE_ID = '11111111-1111-4111-8111-111111111111';
const WAYPOINT_ID = '44444444-4444-4444-8444-444444444444';

const ROUTES = `<?xml version="1.0" encoding="UTF-8" ?>
<gpx><rte><name>Zulu Route</name><time>2026-01-01T00:00:00Z</time>
<extensions><raymarine:GUID>${ROUTE_ID}</raymarine:GUID></extensions>
<rtept lat="10" lon="-20"><name>P1</name></rtept>
<rtept lat="10.1" lon="-20.1"><name>P2</name></rtept></rte></gpx>`;

const MARKERS = `<?xml version="1.0" encoding="UTF-8" ?>
<gpx><wpt lat="11" lon="-21"><name>Alpha Marker</name>
<extensions><raymarine:GUID>${WAYPOINT_ID}</raymarine:GUID></extensions></wpt></gpx>`;

function makeCard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navionics-card-'));
  const archive = path.join(root, 'Navionic', 'Archive');
  fs.mkdirSync(path.join(archive, 'Routes'), { recursive: true });
  fs.mkdirSync(path.join(archive, 'Markers'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'All_Routes.gpx'), ROUTES);
  fs.writeFileSync(path.join(archive, 'All_Markers.gpx'), MARKERS);
  return { root, archive };
}

test('lists card routes and waypoints as read-only resources', async () => {
  const card = makeCard();
  try {
    const provider = new CardResourceProvider({ cardRoot: card.root });
    const routes = await provider.listResources('routes');
    const waypoints = await provider.listResources('waypoints');

    assert.equal(Object.keys(routes).length, 1);
    assert.equal(routes[ROUTE_ID].name, 'Zulu Route');
    assert.equal(routes[ROUTE_ID].$source, 'signalk-navionics');
    assert.equal(Object.keys(waypoints).length, 1);
    assert.equal(waypoints[WAYPOINT_ID].name, 'Alpha Marker');

    const route = await provider.getResource('routes', ROUTE_ID);
    assert.deepEqual(route.feature.geometry.coordinates, [[-20, 10], [-20.1, 10.1]]);

    const geometry = await provider.getResource('routes', ROUTE_ID, 'feature.geometry.type');
    assert.equal(geometry.value, 'LineString');

    await assert.rejects(provider.setResource(), /read-only/);
    await assert.rejects(provider.deleteResource(), /read-only/);
  } finally {
    fs.rmSync(card.root, { recursive: true, force: true });
  }
});

test('falls back to individual route and marker files', async () => {
  const card = makeCard();
  try {
    fs.rmSync(path.join(card.archive, 'All_Routes.gpx'));
    fs.rmSync(path.join(card.archive, 'All_Markers.gpx'));
    fs.writeFileSync(path.join(card.archive, 'Routes', 'Zulu Route.gpx'), ROUTES);
    fs.writeFileSync(path.join(card.archive, 'Markers', 'Alpha Marker.gpx'), MARKERS);

    const provider = new CardResourceProvider({ cardRoot: card.root });
    assert.ok((await provider.listResources('routes'))[ROUTE_ID]);
    assert.ok((await provider.listResources('waypoints'))[WAYPOINT_ID]);
  } finally {
    fs.rmSync(card.root, { recursive: true, force: true });
  }
});

test('registers read-only route and waypoint providers', async () => {
  const card = makeCard();
  try {
    const registered = [];
    const app = { registerResourceProvider: (provider) => registered.push(provider) };
    new CardResourceProvider({ cardRoot: card.root }).register(app);
    assert.deepEqual(registered.map((provider) => provider.type), ['routes', 'waypoints']);
    await assert.rejects(registered[0].methods.setResource(ROUTE_ID, {}), /read-only/);
    assert.equal((await registered[0].methods.listResources())[ROUTE_ID].name, 'Zulu Route');
    assert.equal((await registered[1].methods.listResources())[WAYPOINT_ID].name, 'Alpha Marker');
  } finally {
    fs.rmSync(card.root, { recursive: true, force: true });
  }
});
