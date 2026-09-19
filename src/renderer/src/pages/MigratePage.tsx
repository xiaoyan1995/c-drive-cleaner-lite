import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronRight, Folder, Link2, Play, X } from "lucide-react";
import type {
  DriveInfo,
  MigrateProgress,
  MigrateRecord,
  MigrateResult,
  RecommendedDir,
  ScanResult,
  SystemInfo
} from "../../../shared/types";
import { formatBytes, formatActivityTime } from "../utils/format";
import { normalizeWindowsPath, normalizePath, driveRootFromLetter, isValidMigrationSourcePath, buildTargetPathFromSource } from "../utils/path";
import { findNodeByPath, countSubDirectories } from "../utils/tree";
import { PageHead, Progress } from "../components/ui";

type MigrateBackupMode = "delete_now" | "keep_days";

const MIGRATE_STEPS = ["选择目录", "选择目标盘", "确认预览", "执行迁移", "处理备份", "完成"] as const;

export function MigratePage(): JSX.Element {
  const [currentStep, setCurrentStep] = useState(0);
  const [recommendations, setRecommendations] = useState<RecommendedDir[]>([]);
  const [browseList, setBrowseList] = useState<RecommendedDir[]>([]);
  const [records, setRecords] = useState<MigrateRecord[]>([]);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [loadingDrives, setLoadingDrives] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [sourceSize, setSourceSize] = useState(0);
  const [sourceFileCount, setSourceFileCount] = useState(0);
  const [sourceFolderCount, setSourceFolderCount] = useState(0);
  const [selectedDrive, setSelectedDrive] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [isTargetPathCustomized, setIsTargetPathCustomized] = useState(false);
  const [backupMode, setBackupMode] = useState<MigrateBackupMode>("delete_now");
  const [backupDays, setBackupDays] = useState(7);
  const [stepError, setStepError] = useState<string | null>(null);
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<MigrateProgress | null>(null);
  const [migrationResult, setMigrationResult] = useState<MigrateResult | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [isApplyingBackupPolicy, setIsApplyingBackupPolicy] = useState(false);
  const [backupPolicyApplied, setBackupPolicyApplied] = useState(false);
  const [backupPolicyMessage, setBackupPolicyMessage] = useState<string | null>(null);
  const [systemDrive, setSystemDrive] = useState("C:");
  const [diskFreeBefore, setDiskFreeBefore] = useState<number | null>(null);
  const [diskFreeAfter, setDiskFreeAfter] = useState<number | null>(null);
  const [diskTotalBytes, setDiskTotalBytes] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<MigrateRecord | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [recLimit] = useState(50);

  const api = window.cDriveCleaner;

  // Left list: browse all candidates largest-first
  const sizeOrderedRecs = useMemo(
    () => [...recommendations].sort((a, b) => b.size - a.size),
    [recommendations]
  );
  // Right sidebar: score-priority (cache/AppData first), then size within same score
  const scoredRecs = useMemo(
    () => [...recommendations].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.size - a.size),
    [recommendations]
  );

  const selectedDriveInfo = useMemo(
    () => drives.find((drive) => drive.letter === selectedDrive) ?? null,
    [drives, selectedDrive]
  );
  const usedPercent = selectedDriveInfo && selectedDriveInfo.totalSize > 0
    ? ((selectedDriveInfo.totalSize - selectedDriveInfo.freeSize) / selectedDriveInfo.totalSize) * 100
    : 0;
  const sourcePathReady = isValidMigrationSourcePath(sourcePath, systemDrive);
  const targetPathReady = targetPath.trim().length > 0;
  const driveSpaceEnough = !selectedDriveInfo || sourceSize <= 0 || sourceSize <= selectedDriveInfo.freeSize;
  const estimatedFreedBytes = sourceSize;
  const systemDriveRootPath = driveRootFromLetter(systemDrive);
  const systemDriveLabel = systemDriveRootPath.slice(0, 2).toUpperCase();

  const refreshRecommendations = () => {
    if (!api) return;
    setLoadingRecommendations(true);
    void api
      .invoke<RecommendedDir[]>("migration:get-recommendations", { limit: recLimit })
      .then((rows) => setRecommendations(rows))
      .catch(() => setRecommendations([]))
      .finally(() => setLoadingRecommendations(false));
    void api
      .invoke<RecommendedDir[]>("migration:get-browse-list", { limit: 200 })
      .then((rows) => setBrowseList(rows))
      .catch(() => setBrowseList([]));
  };

  useEffect(() => {
    if (!api) {
      return;
    }
    setLoadingRecommendations(true);
    setLoadingDrives(true);

    void api
      .invoke<RecommendedDir[]>("migration:get-recommendations", { limit: recLimit })
      .then((rows) => setRecommendations(rows))
      .catch(() => setRecommendations([]))
      .finally(() => setLoadingRecommendations(false));
    void api
      .invoke<RecommendedDir[]>("migration:get-browse-list", { limit: 200 })
      .then((rows) => setBrowseList(rows))
      .catch(() => setBrowseList([]));
    void api
      .invoke<DriveInfo[]>("migration:get-drives")
      .then((rows) => setDrives(rows))
      .catch(() => setDrives([]))
      .finally(() => setLoadingDrives(false));
    void api
      .invoke<MigrateRecord[]>("migration:get-records", { limit: 20 })
      .then((rows) => setRecords(rows))
      .catch(() => setRecords([]));
    void api
      .invoke<SystemInfo>("app:get-system-info")
      .then((info) => {
        setSystemDrive(info.drive || "C:");
        setDiskTotalBytes(info.totalDisk);
        setDiskFreeBefore(info.freeDisk);
        setDiskFreeAfter(info.freeDisk);
      })
      .catch(() => undefined);
  }, [api, recLimit]);

  useEffect(() => {
    if (!api) {
      return;
    }
    const offProgress = api.on<MigrateProgress>("migration:progress", (progress) => {
      setMigrationProgress(progress);
      setMigrationError(null);
    });
    const offComplete = api.on<MigrateResult>("migration:complete", (result) => {
      setMigrationResult(result);
      setIsMigrating(false);
      setCurrentStep(4);
      setMigrationError(null);
      void api
        .invoke<MigrateRecord[]>("migration:get-records", { limit: 20 })
        .then((rows) => setRecords(rows))
        .catch(() => undefined);
    });
    return () => {
      offProgress();
      offComplete();
    };
  }, [api]);

  useEffect(() => {
    if (selectedDrive || drives.length === 0) {
      return;
    }
    setSelectedDrive(drives[0].letter);
  }, [drives, selectedDrive]);

  useEffect(() => {
    if (!selectedDrive || !sourcePath || isTargetPathCustomized) {
      return;
    }
    setTargetPath(buildTargetPathFromSource(selectedDrive, sourcePath));
  }, [isTargetPathCustomized, selectedDrive, sourcePath]);

  async function syncSourceStats(path: string): Promise<void> {
    if (!api) {
      return;
    }
    try {
      const lastResult = await api.invoke<ScanResult | null>("scanner:get-last-result");
      if (!lastResult) {
        return;
      }
      const node = findNodeByPath(lastResult.tree, path);
      if (!node) {
        return;
      }
      setSourceSize(node.size);
      setSourceFileCount(node.fileCount ?? 0);
      setSourceFolderCount(countSubDirectories(node));
    } catch {
      // ignore in UI; keep currently known values
    }
  }

  function applySourcePath(path: string, option?: { size?: number; fileCount?: number }): void {
    const normalized = normalizeWindowsPath(path);
    setSourcePath(normalized);
    setManualPath(normalized);
    setSourceSize(option?.size ?? 0);
    setSourceFileCount(option?.fileCount ?? 0);
    setSourceFolderCount(0);
    setStepError(null);
    setIsTargetPathCustomized(false);
    void syncSourceStats(normalized);
  }

  async function handlePickDirectory(): Promise<void> {
    if (!api || isPickingDirectory) {
      return;
    }
    setIsPickingDirectory(true);
    try {
      const result = await api.invoke<{ canceled: boolean; path: string | null }>("migration:pick-directory", {
        defaultPath: manualPath || systemDriveRootPath
      });
      if (!result.canceled && result.path) {
        applySourcePath(result.path);
      }
    } finally {
      setIsPickingDirectory(false);
    }
  }

  function commitManualPath(): void {
    if (!manualPath.trim()) {
      return;
    }
    applySourcePath(manualPath);
  }

  function handleSelectDrive(letter: string): void {
    setSelectedDrive(letter);
    if (!isTargetPathCustomized && sourcePath) {
      setTargetPath(buildTargetPathFromSource(letter, sourcePath));
    }
    setStepError(null);
  }

  function gotoNextStep(): void {
    if (currentStep === 0 && !sourcePathReady) {
      setStepError("请先选择一个系统盘目录，再继续。");
      return;
    }
    if (currentStep === 1) {
      if (!selectedDrive || !targetPathReady) {
        setStepError("请先选择目标盘并确认目标路径。");
        return;
      }
      if (!driveSpaceEnough) {
        setStepError("目标盘剩余空间不足，请更换目标盘或目录。");
        return;
      }
    }
    setStepError(null);
    setCurrentStep((step) => Math.min(MIGRATE_STEPS.length - 1, step + 1));
  }

  function gotoPreviousStep(): void {
    setStepError(null);
    setCurrentStep((step) => Math.max(0, step - 1));
  }

  async function runMigrationExecution(): Promise<void> {
    if (!api || isMigrating) {
      return;
    }
    if (!sourcePathReady || !selectedDrive || !targetPathReady) {
      setStepError("请先完成目录和目标盘配置，再执行迁移。");
      return;
    }
    if (!driveSpaceEnough) {
      setStepError("目标盘剩余空间不足，请先调整目标盘或目录。");
      return;
    }

    setStepError(null);
    setMigrationError(null);
    setMigrationResult(null);
    setMigrationProgress(null);
    setBackupPolicyApplied(false);
    setBackupPolicyMessage(null);
    setCurrentStep(3);
    setIsMigrating(true);
    try {
      const result = await api.invoke<MigrateResult>("migration:start", {
        source: sourcePath,
        target: targetPath,
        backupAction: backupMode,
        backupDays
      });
      setMigrationResult(result);
      setIsMigrating(false);
      if (backupMode === "delete_now") {
        setBackupPolicyApplied(true);
        setBackupPolicyMessage("临时 .bak 已在 Junction 验证成功后删除，系统盘空间已释放。");
        setCurrentStep(5);
        void api
          .invoke<SystemInfo>("app:get-system-info")
          .then((info) => {
            setDiskTotalBytes(info.totalDisk);
            setDiskFreeAfter(info.freeDisk);
          })
          .catch(() => undefined);
        void api
          .invoke<MigrateRecord[]>("migration:get-records", { limit: 20 })
          .then((rows) => setRecords(rows))
          .catch(() => undefined);
      } else {
        setCurrentStep(4);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "迁移执行失败";
      setMigrationError(message);
      setIsMigrating(false);
      setCurrentStep(3);
    }
  }

  async function applyBackupPolicyAndFinish(): Promise<void> {
    if (!api || !migrationResult?.success || isApplyingBackupPolicy) {
      return;
    }
    setIsApplyingBackupPolicy(true);
    setBackupPolicyMessage(null);
    try {
      const response = await api.invoke<{
        applied: boolean;
        action: "delete_now" | "keep_days";
        backupPath: string | null;
        keepDays: number;
        bytesFreed: number;
      }>("migration:apply-backup-policy", {
        recordId: migrationResult.recordId ?? null,
        backupPath: migrationResult.backupPath,
        action: backupMode,
        keepDays: backupDays
      });
      setMigrationResult((current) => (
        current
          ? { ...current, backupPath: response.backupPath, bytesFreed: response.action === "delete_now" ? response.bytesFreed : 0 }
          : current
      ));
      setBackupPolicyApplied(response.applied);
      setBackupPolicyMessage(
        response.action === "delete_now"
          ? "备份目录已删除，系统盘空间已立即释放。"
          : `备份目录已加入计划清理，将在 ${response.keepDays} 天后自动处理。`
      );
      setCurrentStep(5);
      void api
        .invoke<SystemInfo>("app:get-system-info")
        .then((info) => {
          setDiskTotalBytes(info.totalDisk);
          setDiskFreeAfter(info.freeDisk);
        })
        .catch(() => undefined);
      void api
        .invoke<MigrateRecord[]>("migration:get-records", { limit: 20 })
        .then((rows) => setRecords(rows))
        .catch(() => undefined);
    } catch (error) {
      setBackupPolicyMessage(error instanceof Error ? error.message : "备份策略应用失败");
    } finally {
      setIsApplyingBackupPolicy(false);
    }
  }

  async function confirmRollback(): Promise<void> {
    if (!api || !rollbackTarget || isRollingBack) {
      return;
    }
    setIsRollingBack(true);
    setRollbackError(null);
    try {
      await api.invoke<{ success: boolean }>("migration:rollback", { recordId: rollbackTarget.id });
      setRollbackTarget(null);
      void api
        .invoke<MigrateRecord[]>("migration:get-records", { limit: 20 })
        .then((rows) => setRecords(rows))
        .catch(() => undefined);
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : "撤销失败");
    } finally {
      setIsRollingBack(false);
    }
  }

  function statusLabel(status: MigrateRecord["status"]): string {
    if (status === "active") {
      return "健康";
    }
    if (status === "unhealthy") {
      return "异常";
    }
    return "已回滚";
  }

  return (
    <div className="page">
      <PageHead title="软链接迁移向导" subtitle="将占用系统盘空间的大型目录迁移到其他磁盘，并创建 Junction 保持程序透明访问" />
      <div className="stepper">
        {MIGRATE_STEPS.map((step, index) => (
          <div key={step} className={`step ${index === currentStep ? "active" : ""} ${index < currentStep ? "completed" : ""}`}>
            <span className="step-num">{index < currentStep ? <Check size={14} /> : index + 1}</span>
            {step}
          </div>
        ))}
      </div>
      {stepError && <div className="notice warning migrate-notice">{stepError}</div>}

      <div className="grid layout-migrate">
        <section className="stack">
          {currentStep === 0 && (
            <section className="card">
              <div className="card-title">步骤 1：选择目录</div>
              <p className="card-sub">可从推荐迁移目录中直接选择，也可以手动输入或浏览目录。</p>

              <div className="migrate-option-list">
                {loadingRecommendations && <div className="notice info">正在加载推荐迁移目录...</div>}
                {!loadingRecommendations && recommendations.length === 0 && (
                  <div className="notice">暂无推荐目录。先执行一次扫描后，会自动给出迁移建议。</div>
                )}
                {browseList.map((item) => (
                  <button
                    key={item.path}
                    className={`migrate-option ${normalizePath(sourcePath) === normalizePath(item.path) ? "selected" : ""}`}
                    onClick={() => applySourcePath(item.path, { size: item.size, fileCount: item.fileCount })}
                  >
                    <span>
                      <b>{item.path}</b>
                      <small>{item.reason}</small>
                    </span>
                    <span className="migrate-option-meta">
                      <strong>{formatBytes(item.size)}</strong>
                      <small>{item.fileCount.toLocaleString("zh-CN")} 文件</small>
                    </span>
                  </button>
                ))}
              </div>

              <div className="migrate-input-row">
                <input
                  className="text-input"
                  value={manualPath}
                  placeholder={`手动输入目录路径（例如 ${systemDriveLabel}\\Users\\PKD\\Downloads）`}
                  onChange={(event) => setManualPath(event.target.value)}
                  onBlur={commitManualPath}
                />
                <button className="secondary-btn" onClick={() => void handlePickDirectory()}>
                  <Folder size={15} />
                  {isPickingDirectory ? "选择中..." : "浏览目录"}
                </button>
              </div>

              <div className="notice info">
                当前目录：<b>{sourcePathReady ? sourcePath : "未选择"}</b>
                <br />
                目录大小：<b>{formatBytes(sourceSize)}</b>　文件：<b>{sourceFileCount.toLocaleString("zh-CN")}</b>　文件夹：<b>{sourceFolderCount.toLocaleString("zh-CN")}</b>
              </div>

              <div className="step-actions">
                <span className="muted">建议优先迁移 cache/temp/download 类目录。</span>
                <button className="primary-btn" onClick={gotoNextStep} disabled={!sourcePathReady}>
                  下一步
                </button>
              </div>
            </section>
          )}

          {currentStep === 1 && (
            <section className="card">
              <div className="card-title">步骤 2：选择目标盘</div>
              <p className="card-sub">请选择系统盘之外的目标盘，并确认迁移后的目标路径。</p>

              {loadingDrives && <div className="notice info">正在读取可用磁盘...</div>}
              {!loadingDrives && drives.length === 0 && <div className="notice warning">未检测到可用目标盘，请检查 D/E/F 等分区是否存在。</div>}

              <div className="drive-grid">
                {drives.map((drive) => {
                  const selected = drive.letter === selectedDrive;
                  const driveUsedPercent = drive.totalSize > 0 ? ((drive.totalSize - drive.freeSize) / drive.totalSize) * 100 : 0;
                  return (
                    <button key={drive.letter} className={`drive-option ${selected ? "selected" : ""}`} onClick={() => handleSelectDrive(drive.letter)}>
                      <div className="split-note">
                        <b>{drive.letter}</b>
                        <span>{drive.label}</span>
                      </div>
                      <Progress value={driveUsedPercent} tone="purple" />
                      <div className="split-note">
                        <span>{drive.fsType}</span>
                        <span>可用 {formatBytes(drive.freeSize)}</span>
                      </div>
                      <small>总计 {formatBytes(drive.totalSize)}</small>
                    </button>
                  );
                })}
              </div>

              <div className="migrate-input-row">
                <input
                  className="text-input"
                  value={targetPath}
                  placeholder="目标路径（例如 D:\\CDrive_Moved_Data\\Downloads）"
                  onChange={(event) => {
                    setTargetPath(event.target.value);
                    setIsTargetPathCustomized(true);
                  }}
                />
              </div>

              {selectedDriveInfo && sourceSize > selectedDriveInfo.freeSize && (
                <div className="notice warning">
                  目标盘剩余空间不足：需 {formatBytes(sourceSize)}，当前可用 {formatBytes(selectedDriveInfo.freeSize)}。
                </div>
              )}

              <div className="step-actions">
                <button className="secondary-btn" onClick={gotoPreviousStep}>上一步</button>
                <button className="primary-btn" onClick={gotoNextStep} disabled={!selectedDrive || !targetPathReady || !driveSpaceEnough}>
                  下一步
                </button>
              </div>
            </section>
          )}

          {currentStep === 2 && (
            <>
              <section className="card">
                <div className="card-title">步骤 3：确认预览</div>
                <p className="card-sub">即将把以下目录从系统盘迁移到目标位置，并创建 Junction 以保持原路径可用。</p>
                <div className="migrate-flow">
                  <div className="folder-card">
                    <b>源目录（当前）</b>
                    <p>{sourcePath || "未选择源目录"}</p>
                    <small>大小：{formatBytes(sourceSize)}　文件：{sourceFileCount.toLocaleString("zh-CN")} 个　文件夹：{sourceFolderCount.toLocaleString("zh-CN")} 个</small>
                  </div>
                  <ArrowRight className="arrow-big" size={34} />
                  <div className="drive-card">
                    <b>目标位置（迁移后）</b>
                    <p>{targetPath || "未设置目标路径"}</p>
                    <small>
                      剩余空间：{formatBytes(selectedDriveInfo?.freeSize ?? 0)} / {formatBytes(selectedDriveInfo?.totalSize ?? 0)}（{usedPercent.toFixed(1)}% 已使用）
                    </small>
                  </div>
                </div>
                <div className="notice info">迁移完成后将在原路径创建 Junction，所有程序将继续透明访问。</div>
                <div className="notice info">`.bak` 是把原目录临时改名，不会在 C 盘复制第二份数据；只有选择保留时，它才会继续占用原目录本身的空间。</div>
              </section>

              <div className="grid cols-2">
                <section className="card">
                  <div className="card-title">执行步骤（预览）</div>
                  <div className="checklist">
                    {[
                      "复制文件到目标位置",
                      "验证文件大小与完整性",
                      "将原目录临时重命名为 .bak",
                      "创建 Junction（mklink /J）",
                      "验证访问与完整性",
                      backupMode === "delete_now" ? "验证成功后删除临时 .bak" : `保留 .bak ${backupDays} 天`
                    ].map((step, index) => (
                      <div className="checkline" key={step}>
                        <span className="num-dot">{index + 1}</span>
                        <b>{step}</b>
                        <span>待执行</span>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="card">
                  <div className="card-title">备份处理</div>
                  <button className={`choice ${backupMode === "delete_now" ? "selected" : ""}`} onClick={() => setBackupMode("delete_now")}>
                    <span>○ 不保留回滚副本（低空间推荐）</span>
                    <small>仍会临时改名为 .bak；确认 Junction 正常后立即删除并释放空间</small>
                  </button>
                  <button className={`choice ${backupMode === "keep_days" ? "selected" : ""}`} onClick={() => setBackupMode("keep_days")}>
                    <span>● 保留回滚副本 N 天</span>
                    <small>占用原目录大小的系统盘空间，到期自动清理</small>
                  </button>
                  {backupMode === "keep_days" && (
                    <div className="migrate-backup-days">
                      <span>保留天数</span>
                      <input
                        className="text-input"
                        type="number"
                        min={1}
                        max={365}
                        value={backupDays}
                        onChange={(event) => setBackupDays(Math.max(1, Math.min(365, Number(event.target.value) || 1)))}
                      />
                    </div>
                  )}
                </section>
              </div>

              <section className="card release-card">
                <div>
                  <span>预计释放系统盘空间</span>
                  <strong>{formatBytes(estimatedFreedBytes)}</strong>
                  <p>迁移完成后，系统盘可用空间将同步增加。</p>
                </div>
                <div className="release-list">
                  <span>源目录大小 <b>{formatBytes(sourceSize)}</b></span>
                  <span>完整性校验 <b>文件数 + 总大小</b></span>
                  <span>Junction 状态 <b>待验证</b></span>
                </div>
                <div className="release-actions">
                    <small>迁移会先尝试正常关闭占用进程，仍不释放的非系统进程将强制结束；当前程序及其祖先进程不会关闭。</small>
                  <div>
                    <button className="secondary-btn" onClick={gotoPreviousStep}>上一步</button>
                    <button className="primary-btn" onClick={() => void runMigrationExecution()} disabled={isMigrating}>
                      <Play size={18} />
                      {isMigrating ? "迁移中..." : "开始迁移"}
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}

          {currentStep === 3 && (
            <section className="card">
              <div className="card-title">步骤 4：执行迁移</div>
              <p className="card-sub">正在执行复制、校验、Junction 创建流程。可实时查看当前步骤。</p>
              {migrationError && <div className="notice warning">{migrationError}</div>}
              {migrationProgress && (
                <div className="progress-block">
                  <div className="split-note">
                    <span>当前步骤：<b>{migrationProgress.stepName}</b>{migrationProgress.detail ? ` · ${migrationProgress.detail}` : ""}</span>
                    <b>{migrationProgress.percent}%</b>
                  </div>
                  <Progress value={migrationProgress.percent} />
                </div>
              )}
              <div className="checklist">
                {[
                  { key: "check_lock", label: "检测目录占用" },
                  { key: "copy", label: "复制文件到目标位置" },
                  { key: "verify_copy", label: "验证文件完整性" },
                  { key: "rename_bak", label: "重命名原目录为 .bak" },
                  { key: "create_junction", label: "创建 Junction" },
                  { key: "validate_junction", label: "验证访问与完整性" },
                  { key: "cleanup_backup", label: "处理备份目录" }
                ].map((step, index) => {
                  const currentIndex = migrationProgress?.stepIndex ?? -1;
                  const isDone = migrationResult?.success ? true : index < currentIndex;
                  const isRunning = !migrationResult?.success && index === currentIndex && isMigrating;
                  const isFailed = !migrationResult?.success && !isMigrating && Boolean(migrationError) && index === currentIndex;
                  return (
                    <div className="checkline" key={step.key}>
                    <span className="num-dot">{index + 1}</span>
                    <b>{step.label}</b>
                    <span className={`migrate-step-status ${isDone ? "done" : isFailed ? "error" : isRunning ? "running" : "pending"}`}>
                      {isDone ? <Check size={14} /> : isFailed ? <X size={14} /> : null}
                      {isDone ? "已完成" : isFailed ? "失败" : isRunning ? "执行中" : "等待"}
                    </span>
                  </div>
                  );
                })}
              </div>
              <div className="step-actions">
                <button className="secondary-btn" onClick={gotoPreviousStep}>上一步</button>
                <button className="primary-btn" onClick={gotoNextStep} disabled={isMigrating || !migrationResult?.success}>进入备份处理</button>
              </div>
            </section>
          )}

          {currentStep === 4 && (
            <section className="card">
              <div className="card-title">步骤 5：处理备份</div>
              <p className="card-sub">迁移已完成。请选择备份处理方式：立即删除或保留 N 天后自动清理。</p>
              <button className={`choice ${backupMode === "delete_now" ? "selected" : ""}`} onClick={() => setBackupMode("delete_now")}>
                <span>○ 立即删除 .bak（推荐）</span>
                <small>确认后立即删除备份目录，并即时释放空间。</small>
              </button>
              <button className={`choice ${backupMode === "keep_days" ? "selected" : ""}`} onClick={() => setBackupMode("keep_days")}>
                <span>● 保留 N 天</span>
                <small>写入计划清理任务，到期由后台自动清理。</small>
              </button>
              {backupMode === "keep_days" && (
                <div className="chips">
                  {[1, 3, 7, 30].map((days) => (
                    <button
                      key={`keep-${days}`}
                      className={`chip ${backupDays === days ? "active" : ""}`}
                      onClick={() => setBackupDays(days)}
                    >
                      保留 {days} 天
                    </button>
                  ))}
                </div>
              )}
              {backupPolicyMessage && <div className="notice info">{backupPolicyMessage}</div>}
              <div className="step-actions">
                <button className="secondary-btn" onClick={gotoPreviousStep}>上一步</button>
                <button className="primary-btn" onClick={() => void applyBackupPolicyAndFinish()} disabled={!migrationResult?.success || isApplyingBackupPolicy}>
                  {isApplyingBackupPolicy ? "处理中..." : "应用策略并完成"}
                </button>
              </div>
            </section>
          )}

          {currentStep === 5 && (
            <section className="card">
              <div className="card-title">步骤 6：完成</div>
              <p className="card-sub">迁移流程已完成，结果已写入迁移记录。</p>
              <div className={`migrate-result-state ${migrationResult?.success ? "ok" : "error"}`}>
                {migrationResult?.success ? <Check size={18} /> : <X size={18} />}
                <b>{migrationResult?.success ? "迁移成功" : "迁移失败"}</b>
              </div>
              <div className="notice info">
                源目录：{(migrationResult?.sourcePath ?? sourcePath) || "-"}<br />
                目标路径：{(migrationResult?.targetPath ?? targetPath) || "-"}<br />
                实际释放：{formatBytes(migrationResult?.bytesFreed ?? estimatedFreedBytes)}<br />
                迁移文件数：{(migrationResult?.fileCount ?? sourceFileCount).toLocaleString("zh-CN")}<br />
                {diskFreeBefore !== null && diskFreeAfter !== null && (
                  <>
                    系统盘可用空间：{formatBytes(diskFreeBefore)} → {formatBytes(diskFreeAfter)}<br />
                  </>
                )}
                备份处理：{backupPolicyApplied ? (backupPolicyMessage ?? "已完成") : "未应用"}
                {migrationResult?.success ? null : (
                  <>
                    <br />
                    错误原因：{migrationError ?? migrationResult?.error ?? "未知错误"}
                  </>
                )}
              </div>
              <div className="step-actions">
                <button className="secondary-btn" onClick={() => setCurrentStep(0)}>重新选择目录</button>
                <button className="primary-btn" onClick={() => setCurrentStep(0)}>完成</button>
              </div>
            </section>
          )}
        </section>

        <aside className="right-list">
          <section className="card">
            <div className="card-title">
              <span>推荐迁移目录</span>
              <button className="link-btn" onClick={() => setCurrentStep(0)}>
                选择 <ChevronRight size={15} />
              </button>
            </div>
            <div style={{ maxHeight: 360, overflowY: "auto", paddingRight: 2 }}>
              {scoredRecs.slice(0, 15).map((item) => (
                <button
                  className="record-row record-button"
                  key={`recommend-${item.path}`}
                  onClick={() => {
                    applySourcePath(item.path, { size: item.size, fileCount: item.fileCount });
                    setCurrentStep(0);
                  }}
                >
                  <Folder size={18} />
                  <span>
                    <b>{item.path}</b>
                    <small>{formatBytes(item.size)} · {item.fileCount.toLocaleString("zh-CN")} 文件</small>
                  </span>
                  <span className="badge safe">建议迁移</span>
                </button>
              ))}
              {recommendations.length === 0 && !loadingRecommendations && <p className="muted-line">暂无推荐项，先执行扫描可生成建议。</p>}
            </div>
          </section>

          <section className="card">
            <div className="card-title">
              <span>迁移记录</span>
              {records.length > 3 && (
                <button className="link-btn" onClick={() => setShowAllRecords((current) => !current)}>
                  {showAllRecords ? "收起" : "更多"} <ChevronRight size={15} />
                </button>
              )}
            </div>
            {records.slice(0, showAllRecords ? records.length : 3).map((record) => (
              <div className="record-row" key={`record-${record.id}`}>
                <Link2 size={18} />
                <span>
                  <b>{record.sourcePath} → {record.targetPath}</b>
                  <small>{formatBytes(record.sizeBytes)} · {formatActivityTime(record.migratedAt)}</small>
                </span>
                <div className="record-actions">
                  <span className={`badge ${record.status === "active" ? "safe" : record.status === "unhealthy" ? "caution" : "danger"}`}>
                    {statusLabel(record.status)}
                  </span>
                  {(record.status === "active" || record.status === "unhealthy") && (
                    <button className="link-btn danger small-link" onClick={() => setRollbackTarget(record)}>
                      撤销
                    </button>
                  )}
                </div>
              </div>
            ))}
            {records.length === 0 && <p className="muted-line">暂无迁移历史记录。</p>}
          </section>
        </aside>
      </div>

      {rollbackTarget && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="card-title">确认撤销迁移</div>
            <p className="muted-line">将删除 Junction，并把目标目录数据移回原路径。该操作可能耗时较长。</p>
            <div className="notice info">
              原路径：{rollbackTarget.sourcePath}<br />
              目标路径：{rollbackTarget.targetPath}
            </div>
            {rollbackError && <div className="notice warning">{rollbackError}</div>}
            <div className="step-actions">
              <button
                className="secondary-btn"
                onClick={() => {
                  setRollbackTarget(null);
                  setRollbackError(null);
                }}
                disabled={isRollingBack}
              >
                取消
              </button>
              <button className="primary-btn" onClick={() => void confirmRollback()} disabled={isRollingBack}>
                {isRollingBack ? "撤销中..." : "确认撤销"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
