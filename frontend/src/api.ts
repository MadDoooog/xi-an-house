export type CommunityFeature = GeoJSON.Feature<
  GeoJSON.Polygon,
  {
    id: number;
    name: string;
    display_price: number | null;
    category: string;
    district: string | null;
    developer: string | null;
    sold_ratio: number | null;
    boundary_source: string | null;
    price_min: number;
    price_max: number;
  }
>;

export type CommunityDetail = {
  id: number;
  name: string;
  category: string;
  display_price: number | null;
  district: string | null;
  developer: string | null;
  sold_ratio: number | null;
  boundary_source: string | null;
  location_text: string | null;
  sale_type: string | null;
  permit_no: string | null;
  total_units: number | null;
  sold_units: number | null;
  available_units: number | null;
  filing_price: number | null;
  market_price: number | null;
  status: string | null;
  published_at: string | null;
  metadata: Record<string, unknown> | null;
};

export type SummaryStats = {
  total_communities: number;
  by_category: Record<string, number>;
  avg_display_price: number | null;
};

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export async function fetchGeoJson(): Promise<GeoJSON.FeatureCollection> {
  const response = await fetch(`${API_BASE}/api/communities/geojson`);
  if (!response.ok) {
    throw new Error("Failed to load communities");
  }
  return response.json();
}

export async function fetchCommunityDetail(id: number): Promise<CommunityDetail> {
  const response = await fetch(`${API_BASE}/api/communities/${id}`);
  if (!response.ok) {
    throw new Error("Failed to load community detail");
  }
  return response.json();
}

export async function fetchSummary(): Promise<SummaryStats> {
  const response = await fetch(`${API_BASE}/api/stats/summary`);
  if (!response.ok) {
    throw new Error("Failed to load summary");
  }
  return response.json();
}
