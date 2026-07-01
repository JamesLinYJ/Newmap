import { Hono } from 'hono';
export function layerRoutes(postgis, store) {
    return new Hono()
        .post('/api/v1/layers/register', async (c) => {
        const result = await importLayerFromForm(c.req.raw, postgis, {
            sourceType: 'upload',
            defaultCategory: 'upload',
            requireSession: true,
        });
        if ('error' in result)
            return c.json({ detail: result.error }, { status: result.status as never });
        if (result.layer.sessionId) {
            await store.updateSession(result.layer.sessionId, { latestUploadedLayerKey: result.layer.layerKey });
        }
        return c.json(result.layer);
    })
        .post('/api/v1/layers/import', async (c) => {
        const result = await importLayerFromForm(c.req.raw, postgis, {
            sourceType: 'managed',
            defaultCategory: 'managed',
            requireSession: false,
        });
        if ('error' in result)
            return c.json({ detail: result.error }, { status: result.status as never });
        return c.json(result.layer);
    })
        .post('/api/v1/layers/:layerKey/replace', async (c) => {
        const existing = await postgis.getLayer(c.req.param('layerKey'));
        if (!existing)
            return c.json({ detail: '图层不存在' }, { status: 404 });
        const result = await importLayerFromForm(c.req.raw, postgis, {
            layerKey: existing.layerKey,
            sourceType: existing.sourceType,
            defaultCategory: existing.category,
            defaultName: existing.name,
            defaultDescription: existing.description,
            defaultTags: existing.tags,
            sessionId: existing.sessionId,
            threadId: existing.threadId,
            requireSession: false,
        });
        if ('error' in result)
            return c.json({ detail: result.error }, { status: result.status as never });
        return c.json(result.layer);
    });
}
function formatError(error, prefix) {
    return error instanceof Error && error.message ? `${prefix}: ${error.message}` : prefix;
}
async function importLayerFromForm(request, postgis, opts) {
    try {
        const form = await request.formData();
        const file = form.get('file');
        if (!isFileLike(file))
            return { error: '缺少上传文件。', status: 400 };
        if (!isSupportedGeoJsonFilename(file.name)) {
            return { error: `当前 TS 导入器只支持 GeoJSON/JSON 文件：${file.name}`, status: 415 };
        }
        const sessionId = formString(form, 'sessionId') ?? formString(form, 'session_id') ?? opts.sessionId ?? null;
        if (opts.requireSession && !sessionId)
            return { error: 'sessionId 不能为空。', status: 400 };
        const threadId = formString(form, 'threadId') ?? formString(form, 'thread_id') ?? opts.threadId ?? null;
        const collection = parseGeoJsonPayload(JSON.parse(await file.text()));
        const layer = await postgis.importGeoJsonLayer({
            layerKey: opts.layerKey,
            name: formString(form, 'name') ?? opts.defaultName ?? stripExtension(file.name),
            description: formString(form, 'description') ?? opts.defaultDescription ?? '',
            sourceType: opts.sourceType,
            category: formString(form, 'category') ?? opts.defaultCategory,
            status: formString(form, 'status') ?? 'active',
            tags: parseTags(form.get('tags')) ?? opts.defaultTags ?? [],
            sessionId,
            threadId,
            sourceFilename: file.name,
            collection,
        });
        return { layer };
    }
    catch (error) {
        return { error: formatError(error, 'GeoJSON 导入失败'), status: 400 };
    }
}
function parseGeoJsonPayload(value) {
    if (!isRecord(value) || typeof value.type !== 'string') {
        throw new Error('GeoJSON 必须是 FeatureCollection、Feature 或 Geometry');
    }
    if (isGeoJsonFeatureCollection(value)) {
        return value;
    }
    if (isGeoJsonFeature(value)) {
        return { type: 'FeatureCollection', features: [value] };
    }
    if (isGeoJsonGeometry(value)) {
        return {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: value }],
        };
    }
    throw new Error(`不支持的 GeoJSON 类型：${value.type}`);
}
function isGeoJsonFeatureCollection(value) {
    return isRecord(value)
        && value.type === 'FeatureCollection'
        && Array.isArray(value.features)
        && value.features.every(isGeoJsonFeature);
}
function isGeoJsonFeature(value) {
    return isRecord(value)
        && value.type === 'Feature'
        && isGeoJsonGeometry(value.geometry)
        && (value.properties === null || value.properties === undefined || isRecord(value.properties));
}
function isGeoJsonGeometry(value) {
    if (!isRecord(value) || typeof value.type !== 'string')
        return false;
    if (value.type === 'GeometryCollection') {
        return Array.isArray(value.geometries) && value.geometries.every(isGeoJsonGeometry);
    }
    return ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(value.type)
        && Array.isArray(value.coordinates);
}
function isSupportedGeoJsonFilename(name) {
    const lower = name.toLowerCase();
    return lower.endsWith('.geojson') || lower.endsWith('.json');
}
function formString(form, key) {
    const value = form.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function stringField(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function stringArrayField(value) {
    if (Array.isArray(value))
        return value.map(item => String(item).trim()).filter(Boolean);
    if (typeof value === 'string')
        return value.split(',').map(item => item.trim()).filter(Boolean);
    return [];
}
function parseTags(value) {
    if (typeof value !== 'string')
        return null;
    return value.split(',').map(item => item.trim()).filter(Boolean);
}
function stripExtension(name) {
    return name.replace(/\.[^.]+$/u, '') || name;
}
function isFileLike(value) {
    return typeof value === 'object'
        && value !== null
        && 'name' in value
        && typeof value.name === 'string'
        && 'text' in value
        && typeof value.text === 'function';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
