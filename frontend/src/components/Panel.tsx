import type { CommunityFeature } from "../api";
import { BOUNDARY_SOURCE_LABELS } from "../api";

const CATEGORY_LABELS: Record<string, string> = {
  new_home: "新房",
  sold_out: "售罄待交付",
  second_hand: "二手房",
  unknown: "未知",
};

export function Legend() {
  return (
    <div className="legend">
      <strong>房价色阶</strong>
      <div className="legend-bar" />
      <span>低 → 高（绿 → 红）</span>
    </div>
  );
}

export function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] || category;
}

export function formatPrice(price: number | null | undefined) {
  if (!price) return "暂无";
  return `¥${Math.round(price).toLocaleString()}/㎡`;
}

export function boundarySourceLabel(source: string | null | undefined) {
  if (!source) return "—";
  return BOUNDARY_SOURCE_LABELS[source] || source;
}

export function DetailPanel({
  detail,
  isDrawing,
  onStartDraw,
}: {
  detail: CommunityFeature["properties"] | import("../api").CommunityDetail | null;
  isDrawing?: boolean;
  onStartDraw?: () => void;
}) {
  if (!detail) {
    return (
      <div className="detail-panel">
        <h2>小区详情</h2>
        <p>点击地图上的小区查看详情。</p>
      </div>
    );
  }

  const isFull = "location_text" in detail;
  return (
    <div className="detail-panel">
      <h2>{detail.name}</h2>
      <span className={`badge ${detail.category}`}>{categoryLabel(detail.category)}</span>
      <dl>
        <dt>展示价</dt>
        <dd>{formatPrice(detail.display_price)}</dd>
        <dt>区域</dt>
        <dd>{detail.district || "—"}</dd>
        <dt>开发商</dt>
        <dd>{detail.developer || "—"}</dd>
        <dt>去化率</dt>
        <dd>
          {detail.sold_ratio != null ? `${Math.round(detail.sold_ratio * 100)}%` : "—"}
        </dd>
        <dt>边界来源</dt>
        <dd>{boundarySourceLabel(detail.boundary_source)}</dd>
        {isFull && detail.boundary_source === "pending_manual" && onStartDraw && (
          <div className="draw-actions">
            <p className="draw-hint">自动解析未成功，可在地图上手动画定边界。</p>
            <button type="button" className="draw-btn" onClick={onStartDraw} disabled={isDrawing}>
              {isDrawing ? "手画模式中…" : "手画边界"}
            </button>
          </div>
        )}
        {isFull && (
          <>
            <dt>坐落</dt>
            <dd>{detail.location_text || "—"}</dd>
            <dt>销售类型</dt>
            <dd>{detail.sale_type || "—"}</dd>
            <dt>总套数</dt>
            <dd>{detail.total_units ?? "—"}</dd>
            <dt>可售套数</dt>
            <dd>{detail.available_units ?? "—"}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
