import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  FileSearch,
  HardDrive,
  Link2,
  Trash2
} from "lucide-react";
import type {
  ActivityLog,
  DirTree,
  DuplicateProgress,
  FileInfo,
  GrowthItem,
  JunkScanResult,
  ScanProgress,
  ScanStats,
  SystemInfo
} from "../../../shared/types";
import type { DuplicateState, Metric, OneClickStage, OneClickTaskKey, PageId, ScanState } from "../types";
import { formatBytes, formatActivityTime, percent, activityLabel, activityDotClass } from "../utils/format";
import { normalizeScanRootPath } from "../utils/path";
import { formatDuration } from "../utils/format";
import { MetricGrid, PageHead, Progress, Insight, Treemap } from "../components/ui";
import { sortTreeChildren } from "../utils/tree";

const DONUT_TONE_COLORS = ["#2b73f0", "#24c2b0", "#77c86b", "#8c77f5", "#fac42d", "#ff9b35"];

const defaultOneClickQueue: OneClickTaskKey[] = ["disk", "junk"];

export function OverviewPage({
  tree,
  usedPercent,
  systemInfo,
  activityLogs,
  junkResult,
  largeFiles,
  growthRows,
  migrationStats,
  scanRootPath,
  scanState,
  scanProgress,
  scanStats,
  scanElapsedMs,
  oneClickScanning,
  oneClickStage,
  oneClickTaskQueue,
  junkScanState,
  duplicateState,
  duplicateProgress,
  onNavigate,
  onQuickCleanup,
  onScan
}: {
  tree: DirTree;
  usedPercent: number;
  systemInfo: SystemInfo;
  activityLogs: ActivityLog[];
  junkResult: JunkScanResult | null;
  largeFiles: FileInfo[];
  growthRows: GrowthItem[];
  migrationStats: { count: number; savedBytes: number };
  scanRootPath: string;
  scanState: ScanState;
  scanProgress: ScanProgress | null;
  scanStats: ScanStats | null;
  scanElapsedMs: number;
  oneClickScanning: boolean;
  oneClickStage: OneClickStage;
  oneClickTaskQueue: OneClickTaskKey[];
  junkScanState: "idle" | "scanning" | "complete" | "error";
  duplicateState: DuplicateState;
  duplicateProgress: DuplicateProgress | null;
  onNavigate: (page: PageId) => void;
  onQuickCleanup: () => void;
  onScan: () => void;
}): JSX.Element {
  const systemDriveRoot = normalizeScanRootPath(systemInfo.drive || "C:\\");
  const systemDriveLetter = systemDriveRoot.slice(0, 2).toUpperCase();
  const systemDriveName = `${systemDriveLetter.replace(":", "")}盘`;
  const usedBytes = systemInfo.totalDisk - systemInfo.freeDisk;
  const migrationCandidates = (tree.children ?? [])
    .filter((child) => /Users|AppData|Downloads|ProgramData|Cache|Temp/i.test(child.path))
    .filter((child) => child.size >= 1024 ** 3)
    .slice(0, 3);
  const migrationBytes = migrationCandidates.reduce((sum, item) => sum + item.size, 0);
  const todayGrowthBytes = growthRows.reduce((sum, item) => sum + Math.max(0, item.delta), 0);
  const growthRatePeak = growthRows.length > 0
    ? Math.max(...growthRows.map((item) => item.rate * 100))
    : 0;
  const freePercent = systemInfo.totalDisk > 0 ? systemInfo.freeDisk / systemInfo.totalDisk : 0;
  const junkPercent = systemInfo.totalDisk > 0 ? (junkResult?.totalSize ?? 0) / systemInfo.totalDisk : 0;
  const safetyTips = [
    {
      title: "定期清理临时文件",
      ok: junkPercent <= 0.08,
      detail: junkPercent <= 0.08 ? "当前状态符合建议" : "建议执行一次安全清理"
    },
    {
      title: "关注异常增长目录",
      ok: growthRows.length <= 2,
      detail: growthRows.length <= 2 ? "当前状态符合建议" : `今日有 ${growthRows.length} 个目录异常增长`
    },
    {
      title: "保留至少 15% 可用空间",
      ok: freePercent >= 0.15,
      detail: freePercent >= 0.15 ? "当前状态符合建议" : "可用空间偏低，建议尽快释放"
    }
  ];
  const metrics: Metric[] = [
    { label: `${systemDriveName}已用空间`, value: formatBytes(usedBytes), note: `共 ${formatBytes(systemInfo.totalDisk)}（${percent(usedPercent)}）`, icon: HardDrive, tone: "blue", progress: usedPercent },
    { label: "可清理垃圾", value: formatBytes(junkResult?.totalSize ?? 0), note: `${(junkResult?.totalCount ?? 0).toLocaleString("zh-CN")} 项规则命中`, icon: Trash2, tone: "green", progress: systemInfo.totalDisk > 0 ? Math.min(100, ((junkResult?.totalSize ?? 0) / systemInfo.totalDisk) * 100) : 0 },
    { label: "今日异常增长", value: formatBytes(todayGrowthBytes), note: growthRows.length > 0 ? `较昨日 +${growthRatePeak.toFixed(1)}%` : "较昨日 -", icon: Activity, tone: "orange" },
    { label: "已迁移目录", value: migrationStats.count.toString(), note: `节省 ${formatBytes(migrationStats.savedBytes)} 空间`, icon: Link2, tone: "purple" }
  ];
  const top6 = sortTreeChildren(tree).filter((c) => c.size > 0).slice(0, 6);
  const totalDisk = systemInfo.totalDisk;
  const donutGradient = ((): string => {
    if (totalDisk <= 0 || top6.length === 0) return "";
    let stops = "";
    let cum = 0;
    for (let i = 0; i < top6.length; i++) {
      const pct = (top6[i].size / totalDisk) * 100;
      stops += `${DONUT_TONE_COLORS[i]} ${cum.toFixed(2)}% ${(cum + pct).toFixed(2)}%, `;
      cum += pct;
    }
    const remainUsed = usedPercent - cum;
    if (remainUsed > 0.5) stops += `#b0bac8 ${cum.toFixed(2)}% ${usedPercent.toFixed(2)}%, `;
    stops += `#edf1f6 ${usedPercent.toFixed(2)}% 100%`;
    return `conic-gradient(${stops})`;
  })();

  const [showAllLogs, setShowAllLogs] = useState(false);
  const [fullLogs, setFullLogs] = useState<ActivityLog[]>(activityLogs);
  const lastScanLog = activityLogs.find((item) => item.action.includes("scan"));
  const lastScanText = lastScanLog ? formatActivityTime(lastScanLog.timestamp) : "等待首次扫描";
  const scanBusy = scanState === "scanning" || scanState === "paused";
  const scanRoot = normalizeScanRootPath(scanRootPath);
  const diskPercent = scanState === "complete"
    ? 100
    : scanBusy
      ? Math.max(2, scanProgress?.percent ?? 0)
      : 0;
  const junkPercentLive = junkScanState === "complete" ? 100 : junkScanState === "scanning" ? 45 : 0;
  const duplicatePercentLive = duplicateState === "complete"
    ? 100
    : duplicateState === "scanning"
      ? Math.max(8, duplicateProgress?.percent ?? 8)
      : 0;
  const stagePercentMap: Record<OneClickTaskKey, number> = {
    disk: diskPercent,
    junk: junkPercentLive,
    duplicate: duplicatePercentLive
  };
  const activeOneClickQueue = oneClickTaskQueue.length > 0 ? oneClickTaskQueue : defaultOneClickQueue;
  const oneClickPercent = Math.min(
    100,
    Math.round(
      activeOneClickQueue.reduce((sum, key) => sum + stagePercentMap[key], 0) / Math.max(1, activeOneClickQueue.length)
    )
  );
  const overviewProgress = oneClickScanning ? oneClickPercent : diskPercent;
  const oneClickTaskLabel: Record<OneClickTaskKey, string> = {
    disk: "磁盘扫描",
    junk: "垃圾识别",
    duplicate: "重复文件检测"
  };
  const stageIndex = oneClickStage === "disk" || oneClickStage === "junk" || oneClickStage === "duplicate"
    ? activeOneClickQueue.findIndex((task) => task === oneClickStage) + 1
    : 0;
  const oneClickStageLabel = oneClickStage === "done"
    ? `一键扫描完成（${activeOneClickQueue.map((task) => oneClickTaskLabel[task]).join("、")}）`
    : oneClickStage === "error"
      ? "一键扫描中断"
      : oneClickStage === "idle"
        ? "待机"
        : stageIndex > 0
          ? `步骤 ${stageIndex}/${activeOneClickQueue.length}：${oneClickTaskLabel[oneClickStage]}`
          : oneClickTaskLabel[oneClickStage];
  const scanElapsed = formatDuration(scanStats?.elapsedMs ?? scanElapsedMs);
  const livePath = scanProgress?.currentPath ?? scanRoot;

  useEffect(() => {
    setFullLogs(activityLogs);
  }, [activityLogs]);

  async function openAllLogs(): Promise<void> {
    setShowAllLogs(true);
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    try {
      const rows = await api.invoke<ActivityLog[]>("app:get-activity-logs", { limit: 50 });
      if (rows.length > 0) {
        setFullLogs(rows);
      }
    } catch {
      // ignore activity history fetch errors
    }
  }

  return (
    <div className="page">
      <PageHead title={`${systemDriveName}空间总览`} subtitle={`全面掌握 ${systemDriveName}使用情况，安全清理，释放更多空间`} />
      {(scanBusy || oneClickScanning || oneClickStage === "done" || oneClickStage === "error") && (
        <section className="card overview-scan-live">
          <div className="overview-scan-head">
            <strong>{oneClickScanning ? oneClickStageLabel : `${scanRoot} 扫描进度`}</strong>
            <span>{oneClickScanning ? `${oneClickPercent}%` : percent(diskPercent)}</span>
          </div>
          <Progress
            value={overviewProgress}
            tone={oneClickStage === "error" ? "red" : "blue"}
            indeterminate={scanBusy && (scanProgress?.filesScanned ?? 0) <= 0}
          />
          <div className="overview-scan-meta">
            <span>路径：{livePath}</span>
            <span>已处理 {(scanProgress?.filesScanned ?? scanStats?.fileCount ?? 0).toLocaleString("zh-CN")} 文件</span>
            <span>耗时 {scanElapsed}</span>
            <button className="link-btn" onClick={() => onNavigate("scan")}>查看详情 <ChevronRight size={15} /></button>
          </div>
          <div className="overview-scan-steps">
            {activeOneClickQueue.map((taskKey) => (
              <span
                key={taskKey}
                className={`step-pill ${
                  stagePercentMap[taskKey] >= 100
                    ? "done"
                    : oneClickStage === taskKey
                      ? "active"
                      : ""
                }`}
              >
                {oneClickTaskLabel[taskKey]} {percent(stagePercentMap[taskKey])}
              </span>
            ))}
          </div>
        </section>
      )}
      {systemInfo.driveType === "hdd" && (
        <div className="notice">
          ⚠️ 当前选中机械硬盘 (HDD)——频繁全盘扫描会加速磁头磨损，建议扫描一次后复用结果，不要反复重扫。
        </div>
      )}
      <MetricGrid metrics={metrics} columns={4} />

      <div className="grid layout-overview">
        <div className="stack">
          <section className="card">
            <div className="card-title">
              <span>{systemDriveName}使用分布</span>
              <span className="muted">更新：{lastScanText}</span>
              <button className="link-btn" onClick={() => onNavigate("scan")}>详情 <ChevronRight size={15} /></button>
            </div>
            <div className="donut-wrap">
              <div className="donut" style={{ "--donut-used": `${usedPercent}%`, ...(donutGradient ? { background: donutGradient } : {}) } as React.CSSProperties}>
                <div className="donut-center">
                  <div className="donut-num">{formatBytes(usedBytes)}</div>
                  <div className="donut-label">已使用</div>
                  <div className="donut-pct">{percent(usedPercent)}</div>
                </div>
              </div>
              <Treemap tree={tree} compact uniform onSelect={() => onNavigate("scan")} />
            </div>
          </section>

          <section className="card tight">
            <div className="card-title compact">
              <span>{systemDriveName}使用情况（{systemDriveLetter}）</span>
              <span>总计 {formatBytes(systemInfo.totalDisk)}</span>
            </div>
            <Progress value={usedPercent} />
            <div className="split-note">
              <span>已用 {formatBytes(usedBytes)}</span>
              <span>可用 {formatBytes(systemInfo.freeDisk)}</span>
            </div>
          </section>

          <section className="card tight safety-band">
            <div>
              <span className="eyebrow">安全建议</span>
              <strong className={safetyTips.every((item) => item.ok) ? "ok-text" : "warn-text"}>
                {safetyTips.every((item) => item.ok) ? "良好" : "关注"}
              </strong>
            </div>
            {safetyTips.map((item) => (
              <div key={item.title} className="safety-item">
                {item.ok ? <Check size={17} /> : <AlertTriangle size={17} className="warn-text" />}
                <div>
                  <b>{item.title}</b>
                  <span>{item.detail}</span>
                </div>
              </div>
            ))}
          </section>
        </div>

        <aside className="right-list">
          <section className="card">
            <div className="card-title">最近洞察</div>
            <Insight icon={FileSearch} tone="blue" title={largeFiles.length > 0 ? `大文件 Top ${largeFiles.length}` : "大文件分析"} detail={largeFiles.length > 0 ? `发现 ${largeFiles.length} 个大文件，占用 ${formatBytes(largeFiles.reduce((sum, file) => sum + file.size, 0))}` : "点击深度扫描生成真实列表"} onClick={() => onNavigate("scan")} />
            <Insight
              icon={Trash2}
              tone="orange"
              title="推荐清理项"
              detail={junkResult ? `规则命中 ${formatBytes(junkResult.totalSize)}，${junkResult.totalCount.toLocaleString("zh-CN")} 项` : "尚未识别垃圾项，点击开始识别"}
              onClick={() => onNavigate("junk")}
            />
            <Insight icon={Link2} tone="green" title="推荐迁移目录" detail={`可评估 ${migrationCandidates.length} 个目录，约 ${formatBytes(migrationBytes)}`} onClick={() => onNavigate("migrate")} />
          </section>

          <section className="card">
            <div className="card-title">
              <span>活动日志</span>
              <button className="link-btn" onClick={() => void openAllLogs()}>更多 <ChevronRight size={15} /></button>
            </div>
            {activityLogs.length > 0 ? (
              activityLogs.map((log, index) => (
                <div className="log-row" key={`${log.id}-${log.timestamp}`}>
                  <i className={`dot ${index === 1 ? "blue" : activityDotClass(log.action)}`} />
                  <span>{formatActivityTime(log.timestamp)}</span>
                  <b>{activityLabel(log.action)}</b>
                  <span>{log.summary}</span>
                </div>
              ))
            ) : (
              <div className="notice">暂无活动日志，执行一次扫描或清理后会显示记录。</div>
            )}
          </section>
        </aside>
      </div>

      {showAllLogs && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="card-title">活动日志历史</div>
            <div className="legend">
              {fullLogs.map((log) => (
                <span key={`${log.id}-${log.timestamp}`}>
                  <b>{formatActivityTime(log.timestamp)}</b> · {activityLabel(log.action)} · {log.summary}
                </span>
              ))}
            </div>
            <div className="step-actions">
              <button className="secondary-btn" onClick={() => setShowAllLogs(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
