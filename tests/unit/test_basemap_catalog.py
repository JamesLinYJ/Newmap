from api_app.basemap_catalog import BasemapCatalog


def test_basemap_catalog_seeds_osm_and_tianditu():
    catalog = BasemapCatalog(tianditu_api_key="test-token")
    catalog.ensure_schema()

    basemaps = catalog.list_basemaps()
    keys = [item.basemap_key for item in basemaps]

    assert keys == ["osm", "tianditu_vec", "tianditu_img"]
    assert basemaps[0].is_default is True
    assert basemaps[0].tile_urls == ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"]
    assert basemaps[1].available is True
    assert all("tk=test-token" in url for url in basemaps[1].tile_urls)
    assert any("cva_w" in url for url in basemaps[1].label_tile_urls)
    assert any("img_w" in url for url in basemaps[2].tile_urls)
    assert any("cia_w" in url for url in basemaps[2].label_tile_urls)
