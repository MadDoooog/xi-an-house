const PI = Math.PI;
const A = 6378245.0;
const EE = 0.006693421622965943;

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(lng: number, lat: number): number {
  let ret =
    -100.0 +
    2.0 * lng +
    3.0 * lat +
    0.2 * lat * lat +
    0.1 * lng * lat +
    0.2 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lat * PI) + 40.0 * Math.sin((lat / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((lat / 12.0) * PI) + 320 * Math.sin((lat * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(lng: number, lat: number): number {
  let ret =
    300.0 +
    lng +
    2.0 * lat +
    0.1 * lat * lat +
    0.1 * lng * lat +
    0.1 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lng * PI) + 40.0 * Math.sin((lng / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((lng / 12.0) * PI) + 300.0 * Math.sin((lng / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) {
    return [lng, lat];
  }
  const dlat = transformLat(lng - 105.0, lat - 35.0);
  const dlng = transformLng(lng - 105.0, lat - 35.0);
  const radlat = (lat / 180.0) * PI;
  let magic = Math.sin(radlat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const adjLat =
    (dlat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  const adjLng = (dlng * 180.0) / ((A / sqrtMagic) * Math.cos(radlat) * PI);
  return [lng + adjLng, lat + adjLat];
}

function transformPosition(position: [number, number]): [number, number] {
  return wgs84ToGcj02(position[0], position[1]);
}

export function transformPolygonCoordinates(
  coordinates: number[][][],
  toGcj02: boolean,
): number[][][] {
  if (!toGcj02) {
    return coordinates;
  }
  return coordinates.map((ring) =>
    ring.map((position) => transformPosition(position as [number, number])),
  );
}

export type BasemapId = "osm" | "amap";

export const BASEMAP_OPTIONS: { id: BasemapId; label: string }[] = [
  { id: "osm", label: "OpenStreetMap" },
  { id: "amap", label: "高德地图" },
];
