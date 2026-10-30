'use strict';

const fs = require('fs');
const path = require('path');
const gpx = require('./gpx');

const TYPES = {
  routes: {
    aggregate: 'All_Routes.gpx',
    directory: 'Routes',
  },
  waypoints: {
    aggregate: 'All_Markers.gpx',
    directory: 'Markers',
  },
};

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function readDirectory(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.gpx'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const text = readIfExists(file);
    if (text != null) files.push({ name, file, text, stat: fs.statSync(file) });
  }
  return files;
}

class CardResourceProvider {
  constructor(options) {
    this.archiveDir = path.join(options.cardRoot, 'Navionic', 'Archive');
    this.source = options.source || 'signalk-navionics';
    this.log = options.log || (() => {});
    this.cache = new Map();
  }

  async snapshot(type) {
    const spec = TYPES[type];
    if (!spec) throw new Error(`Unsupported resource type: ${type}`);

    const aggregateFile = path.join(this.archiveDir, spec.aggregate);
    const directory = path.join(this.archiveDir, spec.directory);
    let signature = 'missing';
    try {
      const st = fs.statSync(aggregateFile);
      signature = `${aggregateFile}:${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      try {
        const st = fs.statSync(directory);
        signature = `${directory}:${st.mtimeMs}`;
      } catch (dirErr) {
        if (dirErr.code !== 'ENOENT') throw dirErr;
      }
    }

    const cached = this.cache.get(type);
    if (cached && cached.signature === signature) return cached.resources;

    let parsed;
    let mtimeMs = Date.now();
    const aggregate = readIfExists(aggregateFile);
    if (aggregate) {
      parsed = gpx.parseGpx(aggregate);
      mtimeMs = fs.statSync(aggregateFile).mtimeMs;
      if (!parsed.routes.length && !parsed.waypoints.length) parsed = null;
    }
    if (!parsed) {
      parsed = { routes: [], waypoints: [] };
      for (const file of readDirectory(directory)) {
        const item = gpx.parseGpx(file.text);
        parsed.routes.push(...item.routes);
        parsed.waypoints.push(...item.waypoints);
        mtimeMs = Math.max(mtimeMs, file.stat.mtimeMs);
      }
    }

    const timestamp = new Date(mtimeMs).toISOString();
    const resources = {};
    for (const route of parsed.routes) {
      resources[route.id] = {
        ...gpx.routeToResource(route),
        timestamp,
        $source: this.source,
      };
    }
    for (const waypoint of parsed.waypoints) {
      resources[waypoint.id] = {
        ...gpx.waypointToResource(waypoint),
        timestamp,
        $source: this.source,
      };
    }
    this.cache.set(type, { signature, resources });
    this.log(`loaded ${Object.keys(resources).length} ${type} from ${this.archiveDir}`);
    return resources;
  }

  async listResources(type) {
    return this.snapshot(type);
  }

  async getResource(type, id, property) {
    const resources = await this.snapshot(type);
    const resource = resources[id] || resources[id.toUpperCase()];
    if (!resource) throw new Error(`Resource not found: ${type}/${id}`);
    if (!property) return resource;
    const value = property.split('.').reduce((current, key) => (
      current == null ? undefined : current[key]
    ), resource);
    if (value == null) throw new Error(`Resource property not found: ${type}/${id}/${property}`);
    return {
      value,
      timestamp: resource.timestamp,
      $source: resource.$source,
    };
  }

  async setResource() {
    throw new Error('Navionics resources are read-only');
  }

  async deleteResource() {
    throw new Error('Navionics resources are read-only');
  }

  register(app) {
    for (const type of Object.keys(TYPES)) {
      app.registerResourceProvider({
        type,
        methods: {
          listResources: () => this.listResources(type),
          getResource: (id, property) => this.getResource(type, id, property),
          setResource: (id, value) => this.setResource(type, id, value),
          deleteResource: (id) => this.deleteResource(type, id),
        },
      });
    }
  }
}

module.exports = { CardResourceProvider };
