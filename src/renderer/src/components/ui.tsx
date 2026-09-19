import React from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, Folder } from "lucide-react";
import type { DirTree } from "../../../shared/types";
import type { Metric } from "../types";
import type { TreemapRect } from "../utils/tree";
import { sortTreeChildren, buildTreemapRects, findPathChain } from "../utils/tree";
import { formatBytes } from "../utils/format";
import { normalizePath, isSameOrNestedPath } from "../utils/path";
import { levelLabel } from "../utils/format";

export function PageHead({ title, subtitle, right }: { title: string; subtitle: string; right?: React.ReactNode }): JSX.Element {
  return (
    <div className="page-head">
      <div>
        <h1 className="title">{title}</h1>
        <div className="subtitle">{subtitle}</div>
      </div>
      {right}
    </div>
  );
}

export function MetricGrid({ metrics, columns }: { metrics: Metric[]; columns: 4 | 5 }): JSX.Element {
  return (
    <div className={`grid cols-${columns} metric-grid`}>
      {metrics.map((metric) => (
        <section className="card metric" key={metric.label}>
          <div className={`metric-icon ${metric.tone}-bg`}><metric.icon size={25} /></div>
          <div>
            <div className="metric-label">{metric.label}</div>
            <div className="metric-value">{metric.value}</div>
            <div className="metric-note">{metric.note}</div>
            {metric.progress !== undefined && <Progress value={metric.progress} tone={metric.tone} />}
          </div>
        </section>
      ))}
    </div>
  );
}

export function Progress({
  value,
  tone = "blue",
  indeterminate = false
}: {
  value: number;
  tone?: Metric["tone"];
  indeterminate?: boolean;
}): JSX.Element {
  return (
    <div className={`progress ${indeterminate ? "indeterminate" : ""}`}>
      <i className={tone} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function QuickAction({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }): JSX.Element {
  return (
    <button className="quick" onClick={onClick}>
      <Icon size={26} />
      <span>{label}</span>
    </button>
  );
}

export function Insight({ icon: Icon, tone, title, detail, onClick }: { icon: LucideIcon; tone: Metric["tone"]; title: string; detail: string; onClick?: () => void }): JSX.Element {
  return (
    <button className="insight" onClick={onClick}>
      <span className={`metric-icon small ${tone}-bg`}><Icon size={18} /></span>
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      <ChevronRight size={18} />
    </button>
  );
}

export function DataTable({ headers, rows, onRowContextMenu }: {
  headers: string[];
  rows: string[][];
  onRowContextMenu?: (row: string[], event: React.MouseEvent) => void;
}): JSX.Element {
  return (
    <table className="table">
      <thead>
        <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.join("|")}
            onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(row, e) : undefined}
            style={onRowContextMenu ? { cursor: "context-menu" } : undefined}
          >
            {row.map((cell, index) => <td key={`${cell}-${index}`}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TreeRow({
  name,
  size,
  root = false,
  depth,
  selected,
  hasChildren,
  expanded,
  onToggle,
  onSelect
}: {
  name: string;
  size: string;
  root?: boolean;
  depth: number;
  selected: boolean;
  hasChildren: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}): JSX.Element {
  return (
    <div className={`tree-item ${root ? "root" : ""} ${selected ? "selected" : ""}`}>
      <button
        className={`tree-toggle ${expanded ? "expanded" : ""}`}
        onClick={onToggle}
        disabled={!hasChildren}
        aria-label={expanded ? "折叠目录" : "展开目录"}
      >
        <ChevronRight size={14} />
      </button>
      <button className="tree-main" onClick={onSelect} style={{ paddingLeft: `${depth * 12}px` }}>
        <Folder size={15} />
        <span>{name}</span>
      </button>
      <b>{size}</b>
    </div>
  );
}

export function ScanMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="scan-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Badge({ level }: { level: "safe" | "caution" | "danger" }): JSX.Element {
  return <span className={`badge ${level}`}>{levelLabel(level)}</span>;
}

export function ControlCard({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="card control-card">
      <div className="card-title">{title}</div>
      <div className="control-line">{children}</div>
      <p>{detail}</p>
    </section>
  );
}

export function RangeChips({ active, onSelect }: { active: string; onSelect?: (range: "7天" | "30天" | "90天") => void }): JSX.Element {
  const ranges: Array<"7天" | "30天" | "90天"> = ["7天", "30天", "90天"];
  return (
    <div className="chips">
      {ranges.map((range) => (
        <button key={range} className={`chip ${active === range ? "active" : ""}`} onClick={() => onSelect?.(range)}>
          {range}
        </button>
      ))}
    </div>
  );
}

export function Treemap({
  tree,
  compact = false,
  uniform = false,
  focusPath,
  selectedPath,
  onSelect
}: {
  tree: DirTree;
  compact?: boolean;
  uniform?: boolean;
  focusPath?: string;
  selectedPath?: string;
  onSelect?: (path: string) => void;
}): JSX.Element {
  interface TreemapDisplayEntry {
    key: string;
    path: string;
    name: string;
    size: number;
    selectable: boolean;
    denominator: number;
    rect: TreemapRect;
    toneIndex: number;
    muted?: boolean;
  }

  const rootChildren = sortTreeChildren(tree).filter((child) => child.size > 0);
  if (rootChildren.length === 0) {
    return (
      <div className={`treemap ${compact ? "compact" : ""}`}>
        <div className="treemap-empty">
          <b>{tree.size > 0 ? "目录为空" : "等待扫描"}</b>
          <span>{tree.size > 0 ? "当前目录没有可继续下钒的子目录" : "点击『开始扫描』生成真实目录分布"}</span>
        </div>
      </div>
    );
  }

  // Uniform grid mode: render top N items as equal-sized CSS grid cells
  if (uniform) {
    const GRID_COUNT = 6;
    const denominator = tree.size > 0 ? tree.size : rootChildren.reduce((s, c) => s + c.size, 0);
    const gridItems = rootChildren.slice(0, GRID_COUNT);
    const TONE_CLASSES = ["tone-0", "tone-1", "tone-2", "tone-3", "tone-4", "tone-5"];
    const cols = gridItems.length <= 2 ? 2 : gridItems.length <= 3 ? 3 : 3;
    const rows = Math.ceil(gridItems.length / cols);
    return (
      <div
        className="treemap-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
      >
        {gridItems.map((child, i) => (
          <button
            key={child.path}
            className={`tile ${TONE_CLASSES[i % TONE_CLASSES.length]}`}
            title={`${child.name} · ${formatBytes(child.size)} · ${denominator > 0 ? ((child.size / denominator) * 100).toFixed(1) : "0.0"}%`}
            type="button"
            onClick={() => onSelect?.(child.path)}
          >
            <b>{child.name}</b>
            <strong>{formatBytes(child.size)}</strong>
            <small>{denominator > 0 ? ((child.size / denominator) * 100).toFixed(1) : "0.0"}%</small>
          </button>
        ))}
      </div>
    );
  }

  const entries: TreemapDisplayEntry[] = [];
  const minTileRatio = compact ? 0.018 : 0.03;
  const maxVisibleChildren = compact ? 6 : 12;
  const focusChain = focusPath ? findPathChain(tree, focusPath) : [tree];
  const expandPathSet = new Set(focusChain.slice(1).map((node) => normalizePath(node.path)));
  const focusChildByParent = new Map<string, string>();
  for (let index = 0; index < focusChain.length - 1; index += 1) {
    focusChildByParent.set(normalizePath(focusChain[index].path), normalizePath(focusChain[index + 1].path));
  }
  let toneCursor = 0;

  const layoutChildren = (parent: DirTree, parentRect: TreemapRect): void => {
    const children = sortTreeChildren(parent).filter((child) => child.size > 0);
    if (children.length === 0) {
      return;
    }

    const normalizedFocusChild = focusChildByParent.get(normalizePath(parent.path));
    const visibleChildren = children.slice(0, maxVisibleChildren);
    if (normalizedFocusChild && !visibleChildren.some((child) => normalizePath(child.path) === normalizedFocusChild)) {
      const forcedChild = children.find((child) => normalizePath(child.path) === normalizedFocusChild);
      if (forcedChild) {
        if (visibleChildren.length >= maxVisibleChildren) {
          visibleChildren.pop();
        }
        visibleChildren.push(forcedChild);
        visibleChildren.sort((left, right) => right.size - left.size);
      }
    }

    const visibleSet = new Set(visibleChildren.map((child) => normalizePath(child.path)));
    const hiddenSize = children
      .filter((child) => !visibleSet.has(normalizePath(child.path)))
      .reduce((sum, child) => sum + child.size, 0);

    const denominator = parent.size > 0 ? parent.size : children.reduce((sum, child) => sum + child.size, 0);
    const minTileWeight = denominator > 0 ? Math.max(denominator * minTileRatio, 1) : 1;
    type LayoutItem = { kind: "node"; child: DirTree; size: number } | { kind: "others"; size: number };
    const layoutItems: LayoutItem[] = visibleChildren.map((child) => ({ kind: "node", child, size: child.size }));
    if (hiddenSize > 0) {
      layoutItems.push({ kind: "others", size: hiddenSize });
    }
    const rects = buildTreemapRects(layoutItems.map((item) => uniform ? 1 : Math.max(item.size, minTileWeight)));

    for (let index = 0; index < layoutItems.length; index += 1) {
      const item = layoutItems[index];
      const rect = rects[index];
      const absoluteRect: TreemapRect = {
        left: parentRect.left + (rect.left * parentRect.width) / 100,
        top: parentRect.top + (rect.top * parentRect.height) / 100,
        width: (rect.width * parentRect.width) / 100,
        height: (rect.height * parentRect.height) / 100
      };

      if (item.kind === "others") {
        entries.push({
          key: `${parent.path}::others`,
          path: "",
          name: "其他",
          size: item.size,
          selectable: false,
          denominator,
          rect: absoluteRect,
          toneIndex: toneCursor % 6,
          muted: true
        });
        toneCursor += 1;
        continue;
      }

      const child = item.child;
      const shouldExpand = expandPathSet.has(normalizePath(child.path)) && (child.children?.length ?? 0) > 0;
      if (shouldExpand) {
        layoutChildren(child, absoluteRect);
        continue;
      }

      entries.push({
        key: child.path,
        path: child.path,
        name: child.name,
        size: child.size,
        selectable: true,
        denominator,
        rect: absoluteRect,
        toneIndex: toneCursor % 6,
        muted: false
      });
      toneCursor += 1;
    }
  };

  layoutChildren(tree, { left: 0, top: 0, width: 100, height: 100 });

  return (
    <div className={`treemap ${compact ? "compact" : ""}`}>
      {entries.map((entry) => {
        const rect = entry.rect;
        const area = rect.width * rect.height;
        const compactText = area < 620 || rect.width < 22 || rect.height < 18;
        const tinyText = area < 360 || rect.width < 18 || rect.height < 15;
        return (
          <button
            className={`tile ${entry.muted ? "muted" : `tone-${entry.toneIndex}`} ${compactText ? "compact-text" : ""} ${tinyText ? "tiny-text" : ""} ${entry.selectable && selectedPath && isSameOrNestedPath(selectedPath, entry.path) ? "active" : ""}`}
            key={entry.key}
            style={{
              left: `${rect.left.toFixed(4)}%`,
              top: `${rect.top.toFixed(4)}%`,
              width: `${rect.width.toFixed(4)}%`,
              height: `${rect.height.toFixed(4)}%`
            }}
            title={`${entry.name} · ${formatBytes(entry.size)} · ${entry.denominator > 0 ? ((entry.size / entry.denominator) * 100).toFixed(1) : "0.0"}%`}
            type="button"
            disabled={!entry.selectable}
            onClick={() => {
              if (entry.selectable) {
                onSelect?.(entry.path);
              }
            }}
          >
            <b>{entry.name}</b>
            <strong>{formatBytes(entry.size)}</strong>
            <small>{entry.denominator > 0 ? ((entry.size / entry.denominator) * 100).toFixed(1) : "0.0"}%</small>
          </button>
        );
      })}
    </div>
  );
}
