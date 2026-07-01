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
import { GEOCODE_PLACE_PROMPT } from './prompt.js';
export const geocodePlaceTool = {
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
    async handler(args, _runtime) {
        const query = args.query;
        const limit = args.limit ?? 5;
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=${limit}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'geo-agent-platform/0.1' },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            throw new Error(`地理编码查询失败: HTTP ${response.status}`);
        }
        const data = (await response.json());
        if (!Array.isArray(data)) {
            throw new Error('地理编码服务返回格式不是数组');
        }
        const candidates = data.map((item) => ({
            label: item.display_name ?? query,
            latitude: parseFloat(String(item.lat)),
            longitude: parseFloat(String(item.lon)),
            boundingbox: item.boundingbox ?? [],
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
