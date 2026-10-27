import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map, Popup } from "maplibre-gl";
import type { CommunityFeature } from "../api";
import {
  BASEMAP_OPTIONS,
  type BasemapId,
  mapCoordToWgs84,
  transformPolygonCoordinates,
} from "../geo";
import { formatPrice } from "./Panel";

const XIAN_CENTER: [number, number] = [108.94, 34.26];
const DRAFT_SOURCE_ID = "draw-draft";

function priceColor(price: number | null, min: number, max: number) {
  if (price == null || max <= min) {
    return "#94a3b8";
  }
  const ratio = Math.max(0, Math.min(1, (price - min) / (max - min)));
  const r = Math.round(34 + ratio * (239 - 34));
  const g = Math.round(197 - ratio * (197 - 68));
  const b = Math.round(94 - ratio * (94 - 68));
  return `rgb(${r}, ${g}, ${b})`;
}

type Props = {
  features: CommunityFeature[];
  onSelect: (id: number) => void;
  drawCommunityId?: number | null;
  onDrawCancel?: () => void;
  onSaveBoundary?: (communityId: number, polygon: number[][]) => Promise<void>;
};

export function MapView({
  features,
  onSelect,
  drawCommunityId = null,
  onDrawCancel,
  onSaveBoundary,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);
  const [saving, setSaving] = useState(false);
  const isDrawing = drawCommunityId != null;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
          amap: {
            type: "raster",
            tiles: [
              "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
              "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
              "https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
              "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
            ],
            tileSize: 256,
            attribution: "© 高德地图",
          },
        },
        layers: [
          { id: "osm", type: "raster", source: "osm", layout: { visibility: "visible" } },
          { id: "amap", type: "raster", source: "amap", layout: { visibility: "none" } },
        ],
      },
      center: XIAN_CENTER,
      zoom: 10,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }
    map.setLayoutProperty("osm", "visibility", basemap === "osm" ? "visible" : "none");
    map.setLayoutProperty("amap", "visibility", basemap === "amap" ? "visible" : "none");
  }, [basemap]);

  useEffect(() => {
    if (!drawCommunityId) {
      setDraftPoints([]);
    }
  }, [drawCommunityId]);

  const displayFeatures = useMemo(() => {
    const toGcj02 = basemap === "amap";
    return features.map((feature) => ({
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates: transformPolygonCoordinates(feature.geometry.coordinates, toGcj02),
      },
    }));
  }, [features, basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const render = () => {
      const sourceId = "communities";
      const fillLayerId = "communities-fill";
      const lineLayerId = "communities-line";
      const labelLayerId = "communities-label";
      const geojson: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: displayFeatures,
      };

      const prices = displayFeatures
        .map((feature) => feature.properties.display_price)
        .filter((value): value is number => value != null);
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 1;

      for (const feature of displayFeatures) {
        feature.properties.price_min = min;
        feature.properties.price_max = max;
        const price = feature.properties.display_price;
        (feature.properties as CommunityFeature["properties"] & { fill_color: string }).fill_color =
          priceColor(price, min, max);
      }

      const fitToFeatures = () => {
        if (!displayFeatures.length) return;
        const bounds = new maplibregl.LngLatBounds();
        for (const feature of displayFeatures) {
          for (const ring of feature.geometry.coordinates) {
            for (const coord of ring) {
              bounds.extend(coord as [number, number]);
            }
          }
        }
        map.fitBounds(bounds, { padding: 80, maxZoom: 15 });
      };

      if (map.getSource(sourceId)) {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
        return;
      }

      map.addSource(sourceId, { type: "geojson", data: geojson });
      map.addLayer({
        id: fillLayerId,
        type: "fill",
        source: sourceId,
        paint: {
          "fill-color": ["get", "fill_color"],
          "fill-opacity": 0.55,
        },
      });
      map.addLayer({
        id: lineLayerId,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": "#0f172a",
          "line-width": 1.2,
        },
      });
      map.addLayer({
        id: labelLayerId,
        type: "symbol",
        source: sourceId,
        minzoom: 12,
        layout: {
          "text-field": [
            "format",
            ["get", "name"],
            { "font-scale": 1 },
            "\n",
            {},
            [
              "case",
              ["has", "display_price"],
              ["concat", "¥", ["to-string", ["round", ["get", "display_price"]]], "/㎡"],
              "暂无价格",
            ],
            { "font-scale": 0.9 },
          ],
          "text-size": 12,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      if (displayFeatures.length > 0) {
        fitToFeatures();
      }

      const popup = new Popup({ closeButton: false, closeOnClick: false });

      map.on("mousemove", fillLayerId, (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        map.getCanvas().style.cursor = "pointer";
        const props = feature.properties as CommunityFeature["properties"];
        popup
          .setLngLat(event.lngLat)
          .setHTML(`<strong>${props.name}</strong><br/>${formatPrice(props.display_price)}`)
          .addTo(map);
      });

      map.on("mouseleave", fillLayerId, () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      map.on("click", fillLayerId, (event) => {
        if (drawCommunityId != null) return;
        const feature = event.features?.[0];
        if (!feature) return;
        const props = feature.properties as CommunityFeature["properties"];
        onSelect(props.id);
      });
    };

    if (map.isStyleLoaded()) {
      render();
    } else {
      map.once("load", render);
    }
  }, [displayFeatures, drawCommunityId, onSelect]);

  const updateDraftLayer = useCallback(
    (points: [number, number][]) => {
      const map = mapRef.current;
      if (!map || !map.isStyleLoaded()) return;

      const ring = points.length >= 3 ? [...points, points[0]] : points;
      const geojson: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features:
          points.length >= 2
            ? [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "LineString", coordinates: ring },
                },
              ]
            : points.length === 1
              ? [
                  {
                    type: "Feature",
                    properties: {},
                    geometry: { type: "Point", coordinates: points[0] },
                  },
                ]
              : [],
      };

      if (points.length >= 3) {
        geojson.features.push({
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [ring] },
        });
      }

      if (map.getSource(DRAFT_SOURCE_ID)) {
        (map.getSource(DRAFT_SOURCE_ID) as maplibregl.GeoJSONSource).setData(geojson);
        return;
      }

      map.addSource(DRAFT_SOURCE_ID, { type: "geojson", data: geojson });
      map.addLayer({
        id: "draw-draft-fill",
        type: "fill",
        source: DRAFT_SOURCE_ID,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: "draw-draft-line",
        type: "line",
        source: DRAFT_SOURCE_ID,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#1d4ed8", "line-width": 2, "line-dasharray": [2, 1] },
      });
      map.addLayer({
        id: "draw-draft-point",
        type: "circle",
        source: DRAFT_SOURCE_ID,
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 5, "circle-color": "#1d4ed8" },
      });
    },
    [],
  );

  useEffect(() => {
    updateDraftLayer(draftPoints);
  }, [draftPoints, updateDraftLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || drawCommunityId == null) return;

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      setDraftPoints((prev) => [...prev, [event.lngLat.lng, event.lngLat.lat]]);
    };

    map.getCanvas().style.cursor = "crosshair";
    map.on("click", handleClick);

    return () => {
      map.getCanvas().style.cursor = "";
      map.off("click", handleClick);
    };
  }, [drawCommunityId]);

  const undoDraftPoint = () => {
    setDraftPoints((prev) => prev.slice(0, -1));
  };

  const completeDraw = async () => {
    if (!drawCommunityId || !onSaveBoundary || draftPoints.length < 3) return;
    setSaving(true);
    try {
      const wgsRing = draftPoints.map(([lng, lat]) => mapCoordToWgs84(lng, lat, basemap));
      await onSaveBoundary(drawCommunityId, wgsRing);
      setDraftPoints([]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="map-wrap">
      <div className="basemap-switch" role="group" aria-label="Basemap">
        {BASEMAP_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={basemap === option.id ? "active" : ""}
            onClick={() => setBasemap(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {isDrawing && (
        <div className="draw-toolbar" role="toolbar" aria-label="手画边界">
          <span>点击地图添加顶点（至少 3 个）</span>
          <span className="draw-count">已选 {draftPoints.length} 点</span>
          <button type="button" onClick={undoDraftPoint} disabled={!draftPoints.length || saving}>
            撤销
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void completeDraw()}
            disabled={draftPoints.length < 3 || saving}
          >
            {saving ? "保存中…" : "完成并保存"}
          </button>
          <button type="button" onClick={onDrawCancel} disabled={saving}>
            取消
          </button>
        </div>
      )}
      <div ref={containerRef} className="map-container" />
    </div>
  );
}
