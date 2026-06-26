// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 图层查询工具
//
//   文件:       layerQuery.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------
import { makeId } from '../../utils/ids.js';
export function createLayerQueryTool(postgis) {
    return {
        name: 'query_layer',
        label: '查询图层',
        description: '从 PostGIS 图层读取真实要素。',
        group: '空间分析',
        tags: ['postgis', 'query'],
        isReadOnly: true,
        isDestructive: false,
        jsonSchema: {
            type: 'object',
            properties: {
                layerKey: { type: 'string' },
                bbox: { type: 'array' },
                limit: { type: 'integer' },
                properties: { type: 'array' },
            },
            required: ['layerKey'],
        },
        async handler(args) {
            const layerKey = String(args.layerKey);
            const bbox = Array.isArray(args.bbox) ? args.bbox.map(Number) : undefined;
            const limit = typeof args.limit === 'number' ? args.limit : 100;
            const selectedProperties = Array.isArray(args.properties) ? new Set(args.properties.map(String)) : null;
            const rows = await postgis.queryFeatures(layerKey, bbox, limit);
            const totalCount = await postgis.featureCount(layerKey);
            const featureCollection = {
                type: 'FeatureCollection',
                features: rows.map(row => ({
                    type: 'Feature',
                    geometry: row.geometry,
                    properties: selectedProperties
                        ? Object.fromEntries(Object.entries(row.properties).filter(([key]) => selectedProperties.has(key)))
                        : row.properties,
                })),
            };
            return {
                message: `读取 ${rows.length} / ${totalCount} 个要素`,
                payload: { layerKey, totalCount, featureCollection },
                warnings: [],
                resultId: makeId('result'),
                source: 'postgis',
                valueRefs: [{ refId: makeId('ref'), kind: 'feature_collection', label: `${layerKey} 查询结果`, value: featureCollection }],
            };
        },
    };
}