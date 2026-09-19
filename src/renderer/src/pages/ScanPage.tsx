import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowDownToLine,
  CircleGauge,
  FileSearch,
  Folder,
  HardDrive,
  Pause,
  Play,
  Square
} from "lucide-react";
import type { DirTree, DriveInfo, FileInfo, ScanProgress, ScanStats } from "../../../shared/types";
import type { Metric, ScanState } from "../types";
import { formatBytes, formatDate, formatDuration, fileTypeLabel, compareWithPrevious, filterLargeFilesLocal, downloadLargeFilesCsv, downloadFoldersCsv } from "../utils/format";
import { normalizeScanRootPath, driveRootFromLetter } from "../utils/path";
import { MetricGrid, PageHead, Progress, ScanMetric, DataTable } from "../components/ui";

export function ScanPage({
  driveType,
  tree,
  scanRootPath,
  scanDriveOptions,
  scanState,
  scanProgress,
  scanStats,
  previousScanStats,
  scanElapsedMs,
  scanError,
  largeFiles,
  skippedPaths,
  onScanRootPathChange,
  onStart,
  onPauseResume,
  onStop
}: {
  driveType?: "ssd" | "hdd" | "unknown";
  tree: DirTree;
  scanRootPath: string;
  scanDriveOptions: DriveInfo[];
  scanState: ScanState;
  scanProgress: ScanProgress | null;
  scanStats: ScanStats | null;
  previousScanStats: ScanStats | null;
  scanElapsedMs: number;
  scanError: string | null;
  largeFiles: FileInfo[];
  skippedPaths: string[];
  onScanRootPathChange: (path: string) => void;
  onStart: () => void;
  onPauseResume: () => void;
  onStop: () => void;
}): JSX.Element {
  const [showAllSkipped, setShowAllSkipped] = useState(false);
  const [folderQuery, setFolderQuery] = useState("");
  const [folderCategory, setFolderCategory] = useState<"all" | "system" | "user" | "program" | "other">("all");
  const [largeFileType, setLargeFileType] = useState<FileInfo["type"] | "all">("all");
  const [largeFileQuery, setLargeFileQuery] = useState("");
  const [filteredLargeFiles, setFilteredLargeFiles] = useState<FileInfo[]>(largeFiles);

  useEffect(() => {
    setShowAllSkipped(false);
  }, [skippedPaths]);

  useEffect(() => {
    let mounted = true;
    const api = window.cDriveCleaner;
    if (!api) {
      setFilteredLargeFiles(filterLargeFilesLocal(largeFiles, largeFileType, largeFileQuery));
      return () => {
        mounted = false;
      };
    }

    void api
      .invoke<FileInfo[]>("scanner:get-large-files", {
        limit: 50,
        type: largeFileType,
        query: largeFileQuery
      })
      .then((rows) => {
        if (mounted) {
          setFilteredLargeFiles(rows);
        }
      })
      .catch(() => {
        if (mounted) {
          setFilteredLargeFiles(filterLargeFilesLocal(largeFiles, largeFileType, largeFileQuery));
        }
      });

    return () => {
      mounted = false;
    };
  }, [largeFileQuery, largeFileType, largeFiles]);

  const showInFolder = (path: string): void => {
    void window.cDriveCleaner?.invoke("shell:show-in-folder", { path });
  };

  const topFolders = useMemo(() => {
    const folders: DirTree[] = [];
    const walk = (node: DirTree): void => {
      if (node.path !== tree.path) {
        folders.push(node);
      }
      for (const child of node.children ?? []) {
        walk(child);
      }
    };
    walk(tree);
    const all = folders.sort((a, b) => b.size - a.size).slice(0, 50);
    const categorized = folderCategory === "all" ? all : all.filter((f) => {
      const p = f.path.toLowerCase();
      if (folderCategory === "system") return p.includes("\\windows") || p.includes("\\system32") || p.includes("\\programdata");
      if (folderCategory === "user") return p.includes("\\users\\");
      if (folderCategory === "program") return p.includes("\\program files");
      return !p.includes("\\windows") && !p.includes("\\system32") && !p.includes("\\programdata") && !p.includes("\\users\\") && !p.includes("\\program files");
    });
    if (!folderQuery.trim()) return categorized;
    const kw = folderQuery.trim().toLowerCase();
    return categorized.filter((f) => f.name.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw));
  }, [tree, folderQuery, folderCategory]);


  const progress = scanProgress?.percent ?? (scanState === "complete" ? 100 : 0);
  const progressIndeterminate =
    scanState === "scanning"
    && (scanProgress?.filesScanned ?? 0) <= 0
    && (scanProgress?.bytesScanned ?? 0) <= 0
    && (scanStats?.fileCount ?? 0) <= 0;
  const elapsed = scanStats?.elapsedMs ? formatDuration(scanStats.elapsedMs) : formatDuration(scanElapsedMs);
  const scanRoot = normalizeScanRootPath(scanRootPath);
  const selectedDriveLetter = scanRoot.slice(0, 2).toUpperCase();
  const currentDriveType = scanDriveOptions.find(
    (d) => d.letter.replace(":", "").toUpperCase() === selectedDriveLetter.replace(":", "")
  )?.driveType ?? driveType ?? "unknown";
  const scanBusy = scanState === "scanning" || scanState === "paused";
  const stateText: Record<ScanState, string> = {
    idle: "等待扫描",
    scanning: "正在扫描",
    paused: "已暂停",
    stopped: "已停止",
    complete: "已完成",
    error: "扫描失败"
  };
  const titleText =
    scanState === "complete"
      ? "扫描完成"
      : scanState === "idle"
        ? `等待扫描 ${scanRoot}`
        : scanState === "error"
          ? "扫描失败"
          : scanState === "stopped"
            ? "扫描已停止"
            : `正在扫描 ${scanRoot}`;
  const currentPath = progressIndeterminate
    ? "正在建立文件索引，请稍候..."
    : (scanProgress?.currentPath ?? (scanState === "idle" ? "等待开始扫描" : scanRoot));
  const filesScanned = scanStats?.fileCount ?? scanProgress?.filesScanned ?? 0;
  const directoriesScanned = scanStats?.directoryCount ?? scanProgress?.directoriesScanned ?? 0;
  const largeFileCount = scanStats?.largeFileCount ?? largeFiles.length;
  const bytesScanned = scanProgress?.bytesScanned ?? scanStats?.bytesScanned ?? tree.size;
  const stats: Metric[] = [
    { label: "扫描文件数", value: filesScanned.toLocaleString("zh-CN"), note: compareWithPrevious(filesScanned, previousScanStats?.fileCount), icon: FileSearch, tone: "blue" },
    { label: "目录总数", value: directoriesScanned.toLocaleString("zh-CN"), note: compareWithPrevious(directoriesScanned, previousScanStats?.directoryCount), icon: Folder, tone: "green" },
    { label: "超过阈值文件", value: largeFileCount.toLocaleString("zh-CN"), note: compareWithPrevious(largeFileCount, previousScanStats?.largeFileCount), icon: AlertTriangle, tone: "orange" },
    { label: "耗时", value: elapsed, note: scanStats ? compareWithPrevious(scanStats.elapsedMs, previousScanStats?.elapsedMs) : stateText[scanState], icon: CircleGauge, tone: "purple" },
    { label: "扫描大小", value: formatBytes(bytesScanned), note: compareWithPrevious(bytesScanned, previousScanStats?.bytesScanned), icon: HardDrive, tone: "green" }
  ];
  return (
    <div className="page">
      {currentDriveType === "hdd" && (
        <div className="notice">
          ⚠️ 检测到机械硬盘 (HDD)——频繁全盘扫描会加速磁头磨损，建议扫描一次后复用结果，不要反复重扫。
        </div>
      )}
      <PageHead
        title="磁盘扫描与大文件分析"
        subtitle="深度扫描磁盘，快速定位大文件和空间占用"
        right={
          <div className="chips">
            <label className={`chip scan-drive-chip ${scanBusy ? "disabled" : ""}`}>
              <span>扫描路径：</span>
              <select
                className="scan-drive-select"
                value={selectedDriveLetter}
                onChange={(event) => onScanRootPathChange(driveRootFromLetter(event.target.value))}
                disabled={scanBusy}
              >
                {scanDriveOptions.length > 0
                  ? scanDriveOptions.map((drive) => (
                    <option key={drive.letter} value={drive.letter.toUpperCase()}>
                      {drive.letter.toUpperCase()}
                    </option>
                  ))
                  : <option value={selectedDriveLetter}>{selectedDriveLetter}</option>}
              </select>
            </label>
            <span className="chip">输入文件名或扩展名筛选</span>
          </div>
        }
      />

      <section className="card scan-status">
        <div className="scan-main">
          <i className={`spinner ${scanState === "idle" ? "idle" : ""} ${scanState === "complete" ? "done" : ""} ${scanState === "paused" ? "paused" : ""} ${scanState === "stopped" ? "stopped" : ""} ${scanState === "error" ? "error" : ""}`} />
          <div>
            <div className="scan-title">{titleText}</div>
            <div className="scan-path">
              状态：<b>{stateText[scanState]}</b>
              当前路径：{currentPath}
            </div>
            {scanError && <div className="scan-error">{scanError}</div>}
            <Progress value={progressIndeterminate ? 38 : progress} indeterminate={progressIndeterminate} />
          </div>
        </div>
        <ScanMetric label="已用时间" value={elapsed} />
        <ScanMetric label="已处理文件" value={(scanProgress?.filesScanned ?? scanStats?.fileCount ?? 0).toLocaleString("zh-CN")} />
        <ScanMetric label="已扫描大小" value={formatBytes(scanProgress?.bytesScanned ?? scanStats?.bytesScanned ?? 0)} />
        <div className="button-stack">
          {scanState === "scanning" || scanState === "paused" ? (
            <>
              <button className="secondary-btn" onClick={onPauseResume}>
                {scanState === "paused" ? <Play size={15} /> : <Pause size={15} />}
                {scanState === "paused" ? "恢复扫描" : "暂停扫描"}
              </button>
              <button className="secondary-btn danger" onClick={onStop}><Square size={15} /> 停止扫描</button>
            </>
          ) : (
            <button className="secondary-btn" onClick={onStart}><Play size={15} /> {scanState === "complete" || scanState === "stopped" ? "重新扫描" : "开始扫描"}</button>
          )}
        </div>
      </section>

      <MetricGrid metrics={stats} columns={5} />

      <div className="grid layout-scan">
        <section className="card">
          <div className="card-title">
            <span>文件夹 Top 50</span>
            <div className="large-file-tools">
              <div className="chips">
                {([
                  { key: "all", label: "全部" },
                  { key: "system", label: "系统" },
                  { key: "user", label: "用户" },
                  { key: "program", label: "程序" },
                  { key: "other", label: "其他" }
                ] as const).map((chip) => (
                  <button
                    key={chip.key}
                    className={`chip ${folderCategory === chip.key ? "active" : ""}`}
                    onClick={() => setFolderCategory(chip.key)}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
              <input
                className="search-input"
                value={folderQuery}
                onChange={(event) => setFolderQuery(event.target.value)}
                placeholder="搜索文件夹名或路径"
              />
            </div>
          </div>
          {topFolders.length > 0 ? (
            <div className="table-scroll">
              <DataTable
                headers={["文件夹", "路径", "大小", "占比"]}
                rows={topFolders.map((folder) => [
                  folder.name,
                  folder.path,
                  formatBytes(folder.size),
                  tree.size > 0 ? `${((folder.size / tree.size) * 100).toFixed(1)}%` : "–"
                ])}
                onRowContextMenu={(row) => showInFolder(row[1])}
              />
            </div>
          ) : (
            <div className="table-empty-block">
              <b>等待扫描</b>
              <span>完成一次扫描后，这里会展示占用空间最大的文件夹。</span>
            </div>
          )}
          <div className="table-footer">
            <span>显示 {topFolders.length} / 50 项</span>
            <button className="link-btn" onClick={() => downloadFoldersCsv(topFolders.map((f) => ({ name: f.name, path: f.path, size: f.size, ratio: tree.size > 0 ? `${((f.size / tree.size) * 100).toFixed(1)}%` : "–" })))}><ArrowDownToLine size={15} /> 导出列表</button>
          </div>
        </section>

        <section className="card">
          <div className="card-title">
            <span>大文件 Top 50</span>
            <div className="large-file-tools">
              <div className="chips">
                {[
                  { key: "all", label: "全部" },
                  { key: "video", label: "视频" },
                  { key: "archive", label: "压缩包" },
                  { key: "installer", label: "安装包" },
                  { key: "log", label: "日志" },
                  { key: "other", label: "其他" }
                ].map((chip) => (
                  <button
                    key={chip.key}
                    className={`chip ${largeFileType === chip.key ? "active" : ""}`}
                    onClick={() => setLargeFileType(chip.key as FileInfo["type"] | "all")}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
              <input
                className="search-input"
                value={largeFileQuery}
                onChange={(event) => setLargeFileQuery(event.target.value)}
                placeholder="搜索文件名，或输入 .zip 按扩展名过滤"
              />
            </div>
          </div>
          {filteredLargeFiles.length > 0 ? (
            <div className="table-scroll">
              <DataTable
                headers={["文件名", "路径", "大小", "修改时间", "类型"]}
                rows={filteredLargeFiles.map((file) => [file.name, file.path, formatBytes(file.size), formatDate(file.modifiedAt), fileTypeLabel(file.type)])}
                onRowContextMenu={(row) => showInFolder(row[1])}
              />
            </div>
          ) : (
            <div className="table-empty-block">
              <b>等待扫描</b>
              <span>完成一次扫描后，这里会展示真实的大文件列表。</span>
            </div>
          )}
          <div className="table-footer">
            <span>显示 {filteredLargeFiles.length} / {largeFiles.length > 0 ? largeFiles.length : 50} 项</span>
            <button className="link-btn" onClick={() => downloadLargeFilesCsv(filteredLargeFiles)}><ArrowDownToLine size={15} /> 导出列表</button>
          </div>
        </section>
      </div>

      <section className="card tight scan-note">
        <div>
          <b>扫描说明与注意事项</b>
          <p>本次扫描跳过受保护的系统文件夹，以保障系统安全与稳定。扫描结果基于当前权限，部分文件可能因权限不足未被统计。</p>
        </div>
        <div>
          <b>跳过的受保护文件夹</b>
          <div className="chips">
            {(skippedPaths.length > 0 ? (showAllSkipped ? skippedPaths : skippedPaths.slice(0, 5)) : ["等待扫描结果"]).map((chip, index) => (
              <span key={chip} className={`chip ${index === 4 ? "active" : ""}`}>{chip}</span>
            ))}
            {skippedPaths.length > 5 && (
              <button className="link-btn" onClick={() => setShowAllSkipped((current) => !current)}>
                {showAllSkipped ? "收起" : "展开更多"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

