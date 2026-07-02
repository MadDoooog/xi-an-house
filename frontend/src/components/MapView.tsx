import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map, Popup } from "maplibre-gl";
import type { CommunityFeature } from "../api";
import { BASEMAP_OPTIONS, type BasemapId, transformPolygonCoordinates } from "../geo";
import { formatPrice } from "./Panel";

const XIAN_CENTER: [number, number] = [108.94, 34.26];

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
};

export function MapView({ features, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>("osm");

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
        fitToFeatures();
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
  }, [displayFeatures, onSelect]);

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
      <div ref={containerRef} className="map-container" />
    </div>
  );
}
