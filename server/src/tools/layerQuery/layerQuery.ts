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
import type { ToolDef } from '../../framework/types.js';
import type { PostGisRepository } from '../../gis/postgis.js';
import type { GeoJsonFeatureCollection } from '../../gis/geojson.js';
import { QUERY_LAYER_PROMPT } from '../spatial/prompts.js';

type BBox = [number, number, number, number];

export function createLayerQueryTool(postgis: PostGisRepository): ToolDef {
    return {
        name: 'query_layer',
        label: '查询图层',
        description: '从 PostGIS 图层读取真实要素。',
        prompt: QUERY_LAYER_PROMPT,
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
            const bbox = parseBbox(args.bbox);
            const limit = typeof args.limit === 'number' ? args.limit : 100;
            const selectedProperties = Array.isArray(args.properties) ? new Set(args.properties.map(String)) : null;
            const rows = await postgis.queryFeatures(layerKey, bbox, limit);
            const totalCount = await postgis.featureCount(layerKey);
            const featureCollection: GeoJsonFeatureCollection = {
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

function parseBbox(value: unknown): BBox | undefined {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length !== 4)
        throw new Error('bbox 必须是 [minX, minY, maxX, maxY]');
    const bbox = value.map(Number);
    if (!bbox.every(item => Number.isFinite(item)))
        throw new Error('bbox 必须只包含有限数字');
    return [bbox[0], bbox[1], bbox[2], bbox[3]];
}
