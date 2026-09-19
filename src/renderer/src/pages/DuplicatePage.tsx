import { useEffect, useState } from "react";
import { FileArchive, Square, Trash2 } from "lucide-react";
import type {
  DriveInfo,
  DuplicateDeleteReport,
  DuplicateProgress,
  DuplicateScanResult
} from "../../../shared/types";
import type { DuplicateState } from "../types";
import { formatBytes, percent } from "../utils/format";
import { PageHead, Progress } from "../components/ui";

const FILE_TYPE_PRESETS: Array<{ label: string; extensions: string[] }> = [
  { label: "图片", extensions: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "heic", "svg"] },
  { label: "文档", extensions: ["doc", "docx", "pdf", "txt", "xlsx", "xls", "ppt", "pptx", "md", "odt"] },
  { label: "音频", extensions: ["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a"] },
  { label: "视频", extensions: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v", "webm"] },
  { label: "压缩包", extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "cab"] },
];

export function DuplicatePage({
  driveOptions,
  duplicateState,
  duplicateProgress,
  duplicateResult,
  duplicateError,
  duplicateKeepByHash,
  duplicateDeleteReport,
  defaultDriveLetter,
  onStart,
  onStop,
  onKeepChange,
  onDelete
}: {
  driveOptions: DriveInfo[];
  duplicateState: DuplicateState;
  duplicateProgress: DuplicateProgress | null;
  duplicateResult: DuplicateScanResult | null;
  duplicateError: string | null;
  duplicateKeepByHash: Record<string, string>;
  duplicateDeleteReport: DuplicateDeleteReport | null;
  defaultDriveLetter?: string;
  onStart: (opts: { drives: string[]; extensions: string[] }) => void;
  onStop: () => void;
  onKeepChange: (hash: string, path: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [selectedDrives, setSelectedDrives] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set(["图片", "文档"]));
  const [customExt, setCustomExt] = useState("");
  const [useCustom, setUseCustom] = useState(false);

  useEffect(() => {
    if (driveOptions.length === 0) return;
    // Prefer the drive matching defaultDriveLetter (top-bar selection), else C:, else first
    const targetLetter = (defaultDriveLetter ?? "C:").toUpperCase().replace(/\\+$/, "");
    const match = driveOptions.find((d) => d.letter.toUpperCase() === targetLetter);
    setSelectedDrives(new Set([match ? match.letter : (driveOptions[0]?.letter ?? "")]));
  }, [driveOptions, defaultDriveLetter]);

  function toggleDrive(letter: string): void {
    setSelectedDrives((prev) => {
      const next = new Set(prev);
      if (next.has(letter)) next.delete(letter);
      else next.add(letter);
      return next;
    });
  }

  function toggleType(label: string): void {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function buildExtensions(): string[] {
    if (useCustom) {
      return customExt.split(/[;,\s]+/).map((e) => e.trim().replace(/^\./, "")).filter(Boolean);
    }
    return [...selectedTypes].flatMap((label) => FILE_TYPE_PRESETS.find((t) => t.label === label)?.extensions ?? []);
  }

  function handleStart(): void {
    const drives = [...selectedDrives].map((letter) => `${letter.replace(/:$/, "")}:\\`);
    onStart({ drives, extensions: buildExtensions() });
  }

  const duplicateGroups = duplicateResult?.groups ?? [];
  const totalReclaimable = duplicateGroups.reduce((sum, group) => {
    const keep = duplicateKeepByHash[group.hash] ?? group.files[0] ?? "";
    return sum + group.files.filter((path) => path !== keep).length * group.size;
  }, 0);
  const totalFiles = duplicateGroups.reduce((sum, group) => sum + group.files.length, 0);
  const isScanning = duplicateState === "scanning";

  return (
    <div className="page">
      {driveOptions.some((d: DriveInfo) => selectedDrives.has(d.letter) && d.driveType === "hdd") && (
        <div className="notice">
          ⚠️ 选中盘包含机械硬盘 (HDD)：重复文件检测需要遍历全盘，对 HDD 磨损较大。建议不要频繁运行，每周最多检测一次即可。
        </div>
      )}
      <PageHead
        title="重复文件清理"
        subtitle="快速扫描，智能删除重复，释放电脑空间"
        right={
          isScanning ? (
            <button className="secondary-btn danger" onClick={onStop}>
              <Square size={15} /> 停止检测
            </button>
          ) : (
            <button
              className="primary-btn"
              onClick={handleStart}
              disabled={selectedDrives.size === 0}
            >
              <FileArchive size={18} /> 开始查找
            </button>
          )
        }
      />

      {/* Setup panel */}
      <section className="card dup-setup">
        <div className="dup-setup__row">
          <div className="dup-setup__label">
            <input type="radio" checked={!useCustom} onChange={() => setUseCustom(false)} id="dup-preset" />
            <label htmlFor="dup-preset">查找类型</label>
          </div>
          <div className="chips">
            {FILE_TYPE_PRESETS.map((t) => (
              <button
                key={t.label}
                className={`chip ${!useCustom && selectedTypes.has(t.label) ? "active" : ""}`}
                disabled={useCustom}
                onClick={() => { setUseCustom(false); toggleType(t.label); }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="dup-setup__row">
          <div className="dup-setup__label">
            <input type="radio" checked={useCustom} onChange={() => setUseCustom(true)} id="dup-custom" />
            <label htmlFor="dup-custom">自定义</label>
          </div>
          <input
            className="search-input"
            placeholder="请输入文件的后缀名，分号分割（如：jpg; mp4; rmvb）"
            value={customExt}
            disabled={!useCustom}
            onChange={(e) => { setUseCustom(true); setCustomExt(e.target.value); }}
          />
        </div>

        <div className="dup-setup__drives">
          <div className="dup-setup__drives-title">查找位置</div>
          <div className="dup-drives-list">
            {driveOptions.length === 0 && (
              <div className="muted-line">正在读取磁盘列表...</div>
            )}
            {driveOptions.map((d: DriveInfo) => (
              <label key={d.letter} className={`dup-drive-row ${selectedDrives.has(d.letter) ? "selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={selectedDrives.has(d.letter)}
                  onChange={() => toggleDrive(d.letter)}
                />
                <span className="dup-drive-icon">💿</span>
                <span className="dup-drive-letter">{d.letter}</span>
                <span className="dup-drive-label">{d.label || "本地磁盘"}</span>
                <span className="dup-drive-free muted">{formatBytes(d.freeSize)} 可用 / {formatBytes(d.totalSize)}</span>
                <button className="link-btn" onClick={(e) => { e.preventDefault(); toggleDrive(d.letter); }}>
                  {selectedDrives.has(d.letter) ? "移除" : "添加"}
                </button>
              </label>
            ))}
          </div>
        </div>
      </section>

      {/* Progress */}
      {isScanning && duplicateProgress && (
        <section className="card">
          <div className="split-note">
            <span>
              <b>检测中</b> · 阶段：{duplicateProgress.phase} · 已扫描 {(duplicateProgress.scannedFiles ?? 0).toLocaleString("zh-CN")} 文件
            </span>
            <b>{percent(duplicateProgress.percent)}</b>
          </div>
          <Progress value={duplicateProgress.percent} />
        </section>
      )}

      {/* Results */}
      {duplicateState !== "idle" && (
        <section className="card">
          <div className="card-title">
            <span>
              {duplicateState === "complete"
                ? `共 ${duplicateGroups.length} 组重复文件，涉及 ${totalFiles} 个文件`
                : duplicateState === "error" ? "检测失败" : "检测中..."}
            </span>
            <div className="button-row">
              <button className="secondary-btn danger" onClick={onDelete} disabled={duplicateGroups.length === 0}>
                <Trash2 size={15} /> 删除已标记重复项
              </button>
            </div>
          </div>
          {duplicateError && <div className="scan-error">{duplicateError}</div>}
          {duplicateDeleteReport && (
            <div className="notice info">
              已删除 {duplicateDeleteReport.deletedCount} 个文件，释放 {formatBytes(duplicateDeleteReport.bytesFreed)}，失败 {duplicateDeleteReport.failedCount} 个。
            </div>
          )}
          {duplicateGroups.length > 0 && (
            <div className="split-note">
              <span>已选删除副本可回收空间</span>
              <b className="blue">{formatBytes(totalReclaimable)}</b>
            </div>
          )}
          <div className="duplicate-list">
            {duplicateGroups.map((group) => {
              const keep = duplicateKeepByHash[group.hash] ?? group.files[0] ?? "";
              return (
                <div key={group.hash} className="duplicate-group">
                  <div className="split-note">
                    <span>
                      <b>哈希：</b>{group.hash.slice(0, 12)}… · 单文件 {formatBytes(group.size)} · {group.files.length} 份副本
                    </span>
                    <b>可回收 {formatBytes(group.files.filter((path) => path !== keep).length * group.size)}</b>
                  </div>
                  <div className="duplicate-files">
                    {group.files.map((path) => {
                      const checked = keep === path;
                      return (
                        <label key={path} className={`duplicate-file ${checked ? "keep" : "delete"}`}>
                          <input
                            type="radio"
                            name={`dup-keep-${group.hash}`}
                            checked={checked}
                            onChange={() => onKeepChange(group.hash, path)}
                          />
                          <span>{path}</span>
                          <b>{checked ? "保留" : "删除"}</b>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {duplicateState === "complete" && duplicateGroups.length === 0 && (
              <p className="muted-line">未发现重复文件。</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
