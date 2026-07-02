import { DetailPanel, Legend, formatPrice } from "./components/Panel";
import { MapView } from "./components/MapView";
import { useCommunities } from "./hooks/useCommunities";

export default function App() {
  const { features, summary, selected, loading, error, selectCommunity } = useCommunities();

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
        <DetailPanel detail={selected} />
      </aside>
      <main className="map-wrap">
        <MapView features={features} onSelect={selectCommunity} />
      </main>
    </div>
  );
}
