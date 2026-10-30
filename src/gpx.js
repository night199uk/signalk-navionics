'use strict';

const crypto = require('crypto');

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" ?>\n';
const GPX_OPEN = '<gpx xmlns:nvx="https://www.navionics.com" xmlns="http://www.topografix.com/GPX/1/1">\n';
const GPX_CLOSE = '</gpx>\n';
const ROUTE_TYPE = '14';
const WAYPOINT_TYPE = '15';

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(text))) {
    attrs[match[1]] = decodeXml(match[3] != null ? match[3] : match[4]);
  }
  return attrs;
}

function tagText(text, localName, preserveWhitespace = false) {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}>`,
    'i',
  );
  const match = re.exec(text);
  if (!match) return '';
  const value = decodeXml(match[1]);
  return preserveWhitespace ? value : value.trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
}

function normalizedGuid(value) {
  const raw = String(value || '').trim();
  return isUuid(raw) ? raw.toUpperCase() : '';
}

function uuidFromString(value) {
  const hash = crypto.createHash('sha1').update(String(value)).digest('hex');
  const variant = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-`
    + `${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

function cleanName(name, fallback = 'untitled') {
  const raw = String(name == null ? '' : name)
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\s+/, '');
  return raw || fallback;
}

function archiveName(name, maxLength = 15) {
  return cleanName(name).slice(0, maxLength);
}

function fileName(name, maxLength = 15) {
  return `${archiveName(name, maxLength)}.gpx`;
}

function parseGpx(xml) {
  const routes = [];
  const waypoints = [];

  const routeRe = /<rte\b[^>]*>([\s\S]*?)<\/rte>/gi;
  let routeMatch;
  while ((routeMatch = routeRe.exec(xml))) {
    const body = routeMatch[1];
    const header = body.split(/<rtept\b/i)[0];
    const name = tagText(header, 'name', true);
    const time = tagText(header, 'time');
    const guid = normalizedGuid(tagText(header, 'GUID'));
    const points = [];
    const pointRe = /<rtept\b([^>]*)>([\s\S]*?)<\/rtept>/gi;
    let pointMatch;
    while ((pointMatch = pointRe.exec(body))) {
      const attrs = parseAttrs(pointMatch[1]);
      const lat = Number(attrs.lat);
      const lon = Number(attrs.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push({
        lat,
        lon,
        name: tagText(pointMatch[2], 'name', true),
        description: tagText(pointMatch[2], 'desc', true),
        time: tagText(pointMatch[2], 'time'),
        guid: normalizedGuid(tagText(pointMatch[2], 'GUID')),
      });
    }
    if (!points.length) continue;
    const fallbackId = uuidFromString(
      `route:${name}:${time}:${points.map((point) => `${point.lon},${point.lat}`).join(';')}`,
    );
    routes.push({
      id: guid || fallbackId,
      name,
      description: tagText(header, 'desc', true),
      time,
      points,
    });
  }

  const waypointRe = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi;
  let waypointMatch;
  while ((waypointMatch = waypointRe.exec(xml))) {
    const attrs = parseAttrs(waypointMatch[1]);
    const lat = Number(attrs.lat);
    const lon = Number(attrs.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const waypointGuid = normalizedGuid(tagText(waypointMatch[2], 'GUID'));
    const waypointName = tagText(waypointMatch[2], 'name', true);
    const waypointTime = tagText(waypointMatch[2], 'time');
    waypoints.push({
      id: waypointGuid || uuidFromString(`waypoint:${waypointName}:${waypointTime}:${lon},${lat}`),
      name: waypointName,
      description: tagText(waypointMatch[2], 'desc', true),
      time: waypointTime,
      lat,
      lon,
    });
  }

  return { routes, waypoints };
}

function parseArchive(xml) {
  const entries = [];
  const re = /<Item\b([^>]*?)\/?>/gi;
  let match;
  while ((match = re.exec(xml))) {
    const name = parseAttrs(match[1]).name;
    if (!name) continue;
    const parts = name.split('@@');
    if (parts.length < 3) continue;
    const timestamp = parts.pop();
    const type = parts.pop();
    entries.push({
      name: parts.join('@@'),
      type,
      timestamp,
      raw: name,
    });
  }
  return entries;
}

function routeToResource(route) {
  const coordinates = route.points.map((point) => [point.lon, point.lat]);
  const coordinatesMeta = route.points.map((point, index) => {
    const meta = { name: point.name || `WP${String(index).padStart(3, '0')}` };
    if (point.time) meta.time = point.time;
    if (point.guid) meta.guid = normalizedGuid(point.guid);
    return meta;
  });
  const resource = {
    name: cleanName(route.name, `Route ${route.id.slice(0, 8)}`),
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates,
      },
      properties: {
        coordinatesMeta,
      },
    },
  };
  if (route.description) resource.description = route.description;
  if (route.time) resource.feature.properties.time = route.time;
  return resource;
}

function waypointToResource(waypoint) {
  const properties = {};
  if (waypoint.time) properties.time = waypoint.time;
  if (waypoint.guid) properties.guid = normalizedGuid(waypoint.guid);
  const resource = {
    name: cleanName(waypoint.name, `Waypoint ${waypoint.id.slice(0, 8)}`),
    type: 'Waypoint',
    feature: {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [waypoint.lon, waypoint.lat],
      },
      properties,
    },
  };
  if (waypoint.description) resource.description = waypoint.description;
  return resource;
}

function resourceTimestamp(resource, now = new Date()) {
  const raw = resource && resource.timestamp;
  const date = raw ? new Date(raw) : now;
  return Number.isFinite(date.getTime()) ? date : now;
}

function isoTime(resource) {
  const properties = resource && resource.feature && resource.feature.properties;
  const raw = (properties && properties.time) || (resource && resource.timestamp);
  const date = raw ? new Date(raw) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(/\.\d{3}Z$/, 'Z') : new Date().toISOString();
}

function routeElement(id, resource) {
  const geometry = resource.feature && resource.feature.geometry;
  const coordinates = (geometry && geometry.coordinates) || [];
  const properties = (resource.feature && resource.feature.properties) || {};
  const meta = properties.coordinatesMeta || [];
  const time = isoTime(resource);
  const lines = [
    '\t<rte>',
    `\t\t<name>${escapeXml(resource.name || id)}</name>`,
    `\t\t<time>${time}</time>`,
  ];
  if (resource.description) lines.push(`\t\t<desc>${escapeXml(resource.description)}</desc>`);
  lines.push('\t\t<extensions>');
  lines.push(`\t\t\t<raymarine:GUID>${escapeXml(id.toUpperCase())}</raymarine:GUID>`);
  lines.push('\t\t</extensions>');
  coordinates.forEach((position, index) => {
    const point = meta[index] || {};
    const lon = Number(position[0]);
    const lat = Number(position[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const pointGuid = normalizedGuid(point.guid)
      || uuidFromString(`${id.toUpperCase()}:${index}`);
    const pointTime = point.time || time;
    lines.push(`\t\t<rtept lat="${lat}" lon="${lon}">`);
    lines.push(`\t\t\t<name>${escapeXml(point.name || `WP${String(index).padStart(3, '0')}`)}</name>`);
    lines.push(`\t\t\t<time>${pointTime}</time>`);
    lines.push('\t\t\t<extensions>');
    lines.push(`\t\t\t\t<raymarine:GUID>${pointGuid.toUpperCase()}</raymarine:GUID>`);
    lines.push('\t\t\t</extensions>');
    lines.push('\t\t</rtept>');
  });
  lines.push('\t</rte>');
  return `${lines.join('\n')}\n`;
}

function waypointElement(id, resource) {
  const geometry = resource.feature && resource.feature.geometry;
  const position = (geometry && geometry.coordinates) || [];
  const lon = Number(position[0]);
  const lat = Number(position[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const properties = (resource.feature && resource.feature.properties) || {};
  const lines = [
    `\t<wpt lat="${lat}" lon="${lon}">`,
    `\t\t<name>${escapeXml(resource.name || id)}</name>`,
  ];
  if (resource.description) lines.push(`\t\t<desc>${escapeXml(resource.description)}</desc>`);
  lines.push(`\t\t<time>${properties.time || isoTime(resource)}</time>`);
  lines.push('\t\t<extensions>');
  lines.push(`\t\t\t<raymarine:GUID>${escapeXml(id.toUpperCase())}</raymarine:GUID>`);
  lines.push('\t\t</extensions>');
  lines.push('\t</wpt>');
  return `${lines.join('\n')}\n`;
}

function routeGpx(id, resource) {
  return `${XML_HEADER}${GPX_OPEN}${routeElement(id, resource)}${GPX_CLOSE}`;
}

function waypointGpx(id, resource) {
  return `${XML_HEADER}${GPX_OPEN}${waypointElement(id, resource)}${GPX_CLOSE}`;
}

function aggregateGpx(elements) {
  return `${XML_HEADER}${GPX_OPEN}${elements.filter(Boolean).join('')}${GPX_CLOSE}`;
}

function buildArchive(routes, waypoints) {
  const entries = [];
  for (const [id, resource] of Object.entries(routes || {})) {
    entries.push({
      name: archiveName(resource.name || id),
      type: ROUTE_TYPE,
      timestamp: Math.floor(resourceTimestamp(resource).getTime() / 1000),
    });
  }
  for (const [id, resource] of Object.entries(waypoints || {})) {
    entries.push({
      name: archiveName(resource.name || id),
      type: WAYPOINT_TYPE,
      timestamp: Math.floor(resourceTimestamp(resource).getTime() / 1000),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  const lines = ['<Archive>'];
  for (const entry of entries) {
    const name = `${entry.name}@@${entry.type}@@${entry.timestamp}`;
    lines.push(`    <Item name="${escapeXml(name)}" />`);
  }
  lines.push('</Archive>', '');
  return lines.join('\n');
}

module.exports = {
  ROUTE_TYPE,
  WAYPOINT_TYPE,
  XML_HEADER,
  GPX_OPEN,
  GPX_CLOSE,
  archiveName,
  aggregateGpx,
  buildArchive,
  cleanName,
  decodeXml,
  escapeXml,
  fileName,
  isUuid,
  normalizedGuid,
  parseArchive,
  parseGpx,
  resourceTimestamp,
  routeElement,
  routeGpx,
  routeToResource,
  uuidFromString,
  waypointElement,
  waypointGpx,
  waypointToResource,
};
