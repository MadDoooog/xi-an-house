import { useEffect, useState } from "react";
import {
  CommunityDetail,
  CommunityFeature,
  SummaryStats,
  fetchCommunityDetail,
  fetchGeoJson,
  fetchSummary,
} from "../api";

export function useCommunities() {
  const [features, setFeatures] = useState<CommunityFeature[]>([]);
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [selected, setSelected] = useState<CommunityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchGeoJson(), fetchSummary()])
      .then(([geojson, stats]) => {
        setFeatures((geojson.features || []) as CommunityFeature[]);
        setSummary(stats);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const selectCommunity = async (id: number) => {
    try {
      const detail = await fetchCommunityDetail(id);
      setSelected(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load detail");
    }
  };

  return {
    features,
    summary,
    selected,
    loading,
    error,
    selectCommunity,
    clearSelection: () => setSelected(null),
  };
}
