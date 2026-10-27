import { useState } from "react";
import { DetailPanel, Legend, formatPrice } from "./components/Panel";
import { MapView } from "./components/MapView";
import { saveManualBoundary } from "./api";
import { useCommunities } from "./hooks/useCommunities";

export default function App() {
  const { features, summary, selected, loading, error, selectCommunity, refreshGeoJson } =
    useCommunities();
  const [drawTargetId, setDrawTargetId] = useState<number | null>(null);

  const handleSaveBoundary = async (communityId: number, polygon: number[][]) => {
    await saveManualBoundary(communityId, polygon);
    await refreshGeoJson();
    await selectCommunity(communityId);
    setDrawTargetId(null);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>西安楼市 GIS</h1>
        <p>地图展示预售/现售小区边界、备案价与去化情况。</p>
        {loading && <p>加载中...</p>}
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
        {summary && (
          <div className="stat-grid">
            <div className="stat-card">
              <span>小区数量</span>
              <strong>{summary.total_communities}</strong>
            </div>
            <div className="stat-card">
              <span>平均展示价</span>
              <strong>{formatPrice(summary.avg_display_price)}</strong>
            </div>
          </div>
        )}
        <Legend />
        {summary && summary.pending_manual.length > 0 && (
          <div className="pending-list">
            <strong>待手画边界</strong>
            <ul>
              {summary.pending_manual.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => void selectCommunity(item.id)}>
                    {item.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <DetailPanel
          detail={selected}
          isDrawing={drawTargetId != null}
          onStartDraw={() => selected && setDrawTargetId(selected.id)}
        />
      </aside>
      <main className="map-wrap">
        <MapView
          features={features}
          onSelect={selectCommunity}
          drawCommunityId={drawTargetId}
          onDrawCancel={() => setDrawTargetId(null)}
          onSaveBoundary={handleSaveBoundary}
        />
      </main>
    </div>
  );
}
