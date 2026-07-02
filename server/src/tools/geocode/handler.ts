// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地点地理编码工具
//
//   文件:       geocodePlace.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------
import { makeId } from '../../utils/ids.js';
import type { ToolDef } from '../../framework/types.js';
import { GEOCODE_PLACE_PROMPT } from './prompt.js';

interface NominatimCandidate {
    display_name?: unknown;
    lat?: unknown;
    lon?: unknown;
    boundingbox?: unknown;
}

export const geocodePlaceTool: ToolDef = {
    name: 'geocode_place',
    label: '地点地理编码',
    description: '根据地名查询经纬度和边界框。支持城市、区县、POI 等地点类型。',
    prompt: GEOCODE_PLACE_PROMPT,
    group: '地理',
    tags: ['geo', 'search'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: '要查询的地点名称' },
            limit: { type: 'integer', description: '返回结果数量上限', default: 5 },
        },
        required: ['query'],
    },
    async handler(args) {
        const query = requiredText(args.query, 'query');
        const limit = boundedLimit(args.limit);
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=${limit}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'geo-agent-platform/0.1' },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            throw new Error(`地理编码查询失败: HTTP ${response.status}`);
        }
        const data: unknown = await response.json();
        if (!Array.isArray(data)) {
            throw new Error('地理编码服务返回格式不是数组');
        }
        const candidates = data.map((item: unknown) => toCandidate(item, query)).map((item) => ({
            label: item.displayName,
            latitude: item.latitude,
            longitude: item.longitude,
            boundingbox: item.boundingbox,
            source: 'nominatim',
        }));
        return {
            message: candidates.length > 0
                ? `找到 ${candidates.length} 个匹配地点`
                : `未找到匹配 '${query}' 的地点`,
            payload: { query, candidates, count: candidates.length },
            warnings: [],
            valueRefs: candidates.map((c) => ({
                refId: makeId('ref'),
                kind: 'place_candidate',
                label: c.label,
                value: { lat: c.latitude, lon: c.longitude },
            })),
            resultId: makeId('result'),
            source: 'nominatim',
        };
    },
};

function requiredText(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${field} 不能为空`);
    return value.trim();
}

function boundedLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value))
        return 5;
    return Math.min(20, Math.max(1, value));
}

function toCandidate(value: unknown, fallbackLabel: string): {
    displayName: string;
    latitude: number;
    longitude: number;
    boundingbox: unknown[];
} {
    const item = isRecord(value) ? value as NominatimCandidate : {};
    return {
        displayName: typeof item.display_name === 'string' ? item.display_name : fallbackLabel,
        latitude: parseFloat(String(item.lat)),
        longitude: parseFloat(String(item.lon)),
        boundingbox: Array.isArray(item.boundingbox) ? item.boundingbox : [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
