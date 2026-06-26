import { Hono } from 'hono';
const BASEMAPS = [
    {
        basemapKey: 'osm',
        name: 'OpenStreetMap',
        provider: 'OpenStreetMap',
        kind: 'raster',
        attribution: '© OpenStreetMap contributors',
        tileUrls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        labelTileUrls: [],
        available: true,
        isDefault: true,
    },
];
export const mapRoutes = new Hono()
    .get('/api/v1/map/basemaps', (c) => c.json(BASEMAPS));