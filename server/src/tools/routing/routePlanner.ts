// +-------------------------------------------------------------------------
//
//   地理智能平台 - Valhalla 多模式路径规划工具
//
//   文件:       routePlanner.ts
//
//   日期:       2026年06月15日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------
import { makeId } from '../../utils/ids.js';
const COSTING = {
    driving: 'auto',
    walking: 'pedestrian',
    cycling: 'bicycle',
};
export function createRoutePlannerTool(baseUrl, timeoutMs) {
    const endpoint = baseUrl.replace(/\/+$/u, '');
    return {
        name: 'route_planner',
        label: '路径规划',
        description: '通过 Valhalla 和 OSM 路网规划真实驾车、步行或骑行路线。',
        group: '路径规划',
        tags: ['routing', 'navigation', 'osm', 'valhalla'],
        isReadOnly: true,
        isDestructive: false,
        jsonSchema: {
            type: 'object',
            properties: {
                waypoints: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 20,
                    'x-source': 'json',
                    items: {
                        type: 'object',
                        properties: {
                            lat: { type: 'number', minimum: -90, maximum: 90 },
                            lon: { type: 'number', minimum: -180, maximum: 180 },
                        },
                        required: ['lat', 'lon'],
                        additionalProperties: false,
                    },
                    description: '途经点坐标数组',
                },
                profile: {
                    type: 'string',
                    enum: ['driving', 'walking', 'cycling'],
                    description: '出行方式',
                    default: 'driving',
                },
            },
            required: ['waypoints'],
            additionalProperties: false,
        },
        async handler(args) {
            const waypoints = parseWaypoints(args.waypoints);
            const profile = parseProfile(args.profile);
            const response = await fetch(`${endpoint}/route`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'geo-agent-platform/0.1' },
                body: JSON.stringify({
                    locations: waypoints,
                    costing: COSTING[profile],
                    units: 'kilometers',
                    directions_type: 'none',
                    shape_format: 'geojson',
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const raw = await response.text();
            if (!response.ok)
                throw new Error(`Valhalla 路由失败（HTTP ${response.status}）：${raw.slice(0, 300)}`);
            const payload = parseValhallaResponse(raw);
            const route = {
                type: 'Feature',
                properties: { profile, costing: COSTING[profile] },
                geometry: { type: 'LineString', coordinates: payload.coordinates },
            };
            const durationMinutes = Math.max(1, Math.round(payload.timeSeconds / 60));
            return {
                message: `路径规划完成：${waypoints.length} 个途经点，总距离 ${payload.distanceKm.toFixed(1)} km，预计 ${formatDuration(durationMinutes)}`,
                payload: {
                    operation: 'route_planner',
                    waypoints,
                    profile,
                    totalDistanceKm: payload.distanceKm,
                    durationMinutes,
                    durationLabel: formatDuration(durationMinutes),
                    route,
                    segmentCount: Math.max(1, waypoints.length - 1),
                },
                warnings: [],
                resultId: makeId('result'),
                source: 'valhalla',
                provenance: { backend: 'valhalla', dataSource: 'OpenStreetMap', costing: COSTING[profile], endpoint },
                valueRefs: [
                    { refId: makeId('ref'), kind: 'route', label: '规划路径', value: route },
                    { refId: makeId('ref'), kind: 'distance', label: '总距离', value: payload.distanceKm, unit: 'km' },
                    { refId: makeId('ref'), kind: 'duration', label: '预估时间', value: durationMinutes, unit: 'min' },
                ],
            };
        },
    };
}
function parseWaypoints(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 20)
        throw new Error('路径规划需要 2 到 20 个途经点');
    return value.map((item, index) => {
        if (!isRecord(item))
            throw new Error(`waypoints[${index}] 必须是对象`);
        const lat = item.lat;
        const lon = item.lon;
        if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90)
            throw new Error(`waypoints[${index}].lat 非法`);
        if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180)
            throw new Error(`waypoints[${index}].lon 非法`);
        return { lat, lon };
    });
}
function parseProfile(value) {
    const profile = value === undefined ? 'driving' : String(value);
    if (profile !== 'driving' && profile !== 'walking' && profile !== 'cycling')
        throw new Error(`不支持的出行方式：${profile}`);
    return profile;
}
function parseValhallaResponse(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('Valhalla 返回了无法解析的 JSON');
    }
    if (!isRecord(value) || !isRecord(value.trip) || !isRecord(value.trip.summary))
        throw new Error('Valhalla 返回缺少 trip.summary');
    const legs = Array.isArray(value.trip.legs) ? value.trip.legs : [];
    const coordinates = legs.flatMap((leg, index) => {
        if (!isRecord(leg))
            throw new Error(`Valhalla leg ${index} 非法`);
        return parseShape(leg.shape, index);
    });
    if (coordinates.length < 2)
        throw new Error('Valhalla 未返回可用路线几何');
    const distanceKm = value.trip.summary.length;
    const timeSeconds = value.trip.summary.time;
    if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm))
        throw new Error('Valhalla 路线距离非法');
    if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds))
        throw new Error('Valhalla 路线时长非法');
    return { coordinates: removeAdjacentDuplicates(coordinates), distanceKm, timeSeconds };
}
function parseShape(value, legIndex) {
    if (typeof value === 'string' && value)
        return decodePolyline6(value);
    if (!isRecord(value) || value.type !== 'LineString' || !Array.isArray(value.coordinates)) {
        throw new Error(`Valhalla leg ${legIndex} 未返回 GeoJSON LineString`);
    }
    return value.coordinates.map((coordinate, index) => {
        if (!Array.isArray(coordinate) || coordinate.length < 2 || coordinate.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
            throw new Error(`Valhalla leg ${legIndex} 坐标 ${index} 非法`);
        }
        return coordinate;
    });
}
function decodePolyline6(encoded) {
    const coordinates = [];
    let index = 0;
    let latitude = 0;
    let longitude = 0;
    while (index < encoded.length) {
        const lat = decodePolylineValue(encoded, index);
        index = lat.nextIndex;
        const lon = decodePolylineValue(encoded, index);
        index = lon.nextIndex;
        latitude += lat.delta;
        longitude += lon.delta;
        coordinates.push([longitude / 1e6, latitude / 1e6]);
    }
    return coordinates;
}
function decodePolylineValue(encoded, startIndex) {
    let result = 0;
    let shift = 0;
    let index = startIndex;
    let byte;
    do {
        if (index >= encoded.length)
            throw new Error('Valhalla polyline 编码不完整');
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
    } while (byte >= 0x20);
    return { delta: (result & 1) ? ~(result >> 1) : result >> 1, nextIndex: index };
}
function removeAdjacentDuplicates(coordinates) {
    return coordinates.filter((coordinate, index) => index === 0 || coordinate[0] !== coordinates[index - 1][0] || coordinate[1] !== coordinates[index - 1][1]);
}
function formatDuration(minutes) {
    if (minutes < 60)
        return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}