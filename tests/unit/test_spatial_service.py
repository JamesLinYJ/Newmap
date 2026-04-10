from pathlib import Path

from gis_postgis import LayerCatalog, SpatialAnalysisService


def build_service():
    catalog = LayerCatalog(Path("data"))
    return SpatialAnalysisService(catalog)


def test_intersection_returns_nearby_paris_hospitals():
    service = build_service()
    boundary = service.load_boundary("巴黎")
    metros = service.load_layer("metro_stations", area_name="巴黎", boundary=boundary)
    hospitals = service.load_layer("hospitals", area_name="巴黎", boundary=boundary)
    metro_buffer = service.buffer(metros, 1000)
    result = service.intersect(hospitals, metro_buffer)
    assert len(result["features"]) >= 1


def test_point_in_polygon_filters_inside_points():
    service = build_service()
    boundary = service.load_boundary("柏林")
    uploaded = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "inside"},
                "geometry": {"type": "Point", "coordinates": [13.405, 52.52]},
            },
            {
                "type": "Feature",
                "properties": {"name": "outside"},
                "geometry": {"type": "Point", "coordinates": [2.35, 48.85]},
            },
        ],
    }
    result = service.point_in_polygon(uploaded, boundary)
    assert len(result["features"]) == 1
    assert result["features"][0]["properties"]["name"] == "inside"

