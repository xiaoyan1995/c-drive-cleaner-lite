import { useEffect, useState } from "react";
import { Power } from "lucide-react";
import type { JunkCategory, SafeLevel } from "../../../shared/types";
import type { CustomRuleRow } from "../types";
import { formatBytes, formatActivityTime, categoryLabel } from "../utils/format";
import { PageHead } from "../components/ui";

export function SettingsPage({
  monitorEnabled,
  adminGranted,
  settings,
  appMeta,
  dbSummary,
  loginItemStatus,
  onToggleMonitor,
  onSettingChange,
  onUpdateRules,
  onResetSettings,
  onPickDirectory
}: {
  monitorEnabled: boolean;
  adminGranted: boolean;
  settings: Record<string, unknown>;
  appMeta: { name: string; version: string; description: string };
  dbSummary: {
    available: boolean;
    version: number;
    path?: string;
    appDir: string;
    rulesVersion: string;
    rulesLastUpdated: string | null;
    latestBackupAt: string | null;
  };
  loginItemStatus: {
    openAtLogin: boolean;
    executableWillLaunchAtLogin: boolean;
  } | null;
  onToggleMonitor: () => void;
  onSettingChange: (key: string, value: unknown) => void;
  onUpdateRules: () => void;
  onResetSettings: () => void;
  onPickDirectory: (defaultPath: string) => Promise<string | null>;
}): JSX.Element {
  const scanDepth = (settings["scan.depth"] as string) ?? "deep";
  const scanThresholdBytes = Number(settings["scan.largeFileThreshold"] ?? 104857600);
  const scanThresholdMb = Math.max(1, Math.round(scanThresholdBytes / 1024 / 1024));
  const preferredEngine = (settings["scan.preferredEngine"] as string) ?? "auto";
  const includeArchives = settings["scan.includeArchives"] === true;

  const cleanupLogDays = Number(settings["cleanup.logRetentionDays"] ?? 7);
  const cleanupDefaultSelection = (settings["cleanup.defaultSelection"] as string) ?? "recommended";
  const cleanupRiskConfirm = (settings["cleanup.riskConfirm"] as string) ?? "high_only";
  const cleanupCreateRestore = settings["cleanup.createRestorePoint"] !== false;

  const migrateDefaultTarget = (settings["migrate.defaultTargetPath"] as string) ?? "D:\\CDrive_Moved_Data";
  const migrateBackupDays = Number(settings["migrate.backupRetentionDays"] ?? 7);
  const migrateCheckLock = settings["migrate.checkProcessLock"] !== false;

  const trayAutoStart = settings["tray.autoStart"] === true;
  const trayMinimizeToTray = settings["tray.minimizeToTray"] !== false;
  const trayCloseToTray = settings["tray.closeToTray"] !== false;
  const trayScanAnimation = settings["tray.scanAnimation"] !== false;
  const autoStartLastBootLaunchAt = typeof settings["tray.lastAutoStartBootLaunchAt"] === "string"
    ? settings["tray.lastAutoStartBootLaunchAt"] as string
    : null;
  const autoStartRegistered = loginItemStatus?.openAtLogin ?? trayAutoStart;
  const autoStartReady = loginItemStatus?.executableWillLaunchAtLogin ?? true;

  const [thresholdMbInput, setThresholdMbInput] = useState(String(scanThresholdMb));
  const [cleanupLogDaysInput, setCleanupLogDaysInput] = useState(String(cleanupLogDays));
  const [migrateBackupDaysInput, setMigrateBackupDaysInput] = useState(String(migrateBackupDays));
  const [targetPathInput, setTargetPathInput] = useState(migrateDefaultTarget);
  const [customRules, setCustomRules] = useState<CustomRuleRow[]>([]);
  const [editingRule, setEditingRule] = useState<CustomRuleRow | null>(null);
  const [ruleFormError, setRuleFormError] = useState<string | null>(null);
  const [ruleActionError, setRuleActionError] = useState<string | null>(null);
  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [ruleForm, setRuleForm] = useState<{
    id: string;
    name: string;
    category: JunkCategory;
    paths: string;
    pattern: string;
    safeLevel: SafeLevel;
    description: string;
    enabled: boolean;
  }>({
    id: "",
    name: "",
    category: "temp_files",
    paths: "",
    pattern: "",
    safeLevel: "safe",
    description: "",
    enabled: true
  });

  function getDesktopApi(action: string): NonNullable<Window["cDriveCleaner"]> | null {
    const api = window.cDriveCleaner;
    if (api) {
      return api;
    }
    setRuleActionError(`未连接桌面桥接，无法${action}`);
    return null;
  }

  useEffect(() => {
    setThresholdMbInput(String(scanThresholdMb));
  }, [scanThresholdMb]);
  useEffect(() => {
    setCleanupLogDaysInput(String(cleanupLogDays));
  }, [cleanupLogDays]);
  useEffect(() => {
    setMigrateBackupDaysInput(String(migrateBackupDays));
  }, [migrateBackupDays]);
  useEffect(() => {
    setTargetPathInput(migrateDefaultTarget);
  }, [migrateDefaultTarget]);

  useEffect(() => {
    let mounted = true;
    const api = window.cDriveCleaner;
    if (!api) {
      setCustomRules([]);
      return () => {
        mounted = false;
      };
    }
    void api.invoke<CustomRuleRow[]>("rules:get-custom").then((rows) => {
      if (!mounted) {
        return;
      }
      setCustomRules(rows ?? []);
    }).catch(() => {
      if (mounted) {
        setCustomRules([]);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  function commitThresholdMb(): void {
    const parsed = Number(thresholdMbInput);
    if (!Number.isFinite(parsed)) {
      setThresholdMbInput(String(scanThresholdMb));
      return;
    }
    const nextMb = Math.max(10, Math.min(10240, Math.round(parsed)));
    onSettingChange("scan.largeFileThreshold", nextMb * 1024 * 1024);
  }

  function commitCleanupLogDays(): void {
    const parsed = Number(cleanupLogDaysInput);
    if (!Number.isFinite(parsed)) {
      setCleanupLogDaysInput(String(cleanupLogDays));
      return;
    }
    onSettingChange("cleanup.logRetentionDays", Math.max(1, Math.min(365, Math.round(parsed))));
  }

  function commitMigrateBackupDays(): void {
    const parsed = Number(migrateBackupDaysInput);
    if (!Number.isFinite(parsed)) {
      setMigrateBackupDaysInput(String(migrateBackupDays));
      return;
    }
    onSettingChange("migrate.backupRetentionDays", Math.max(1, Math.min(365, Math.round(parsed))));
  }

  function commitTargetPath(): void {
    const normalized = targetPathInput.trim();
    if (normalized.length === 0) {
      setTargetPathInput(migrateDefaultTarget);
      return;
    }
    onSettingChange("migrate.defaultTargetPath", normalized);
  }

  function openCreateRuleModal(): void {
    setEditingRule(null);
    setRuleFormError(null);
    setRuleForm({
      id: "",
      name: "",
      category: "temp_files",
      paths: "",
      pattern: "",
      safeLevel: "safe",
      description: "",
      enabled: true
    });
    setIsRuleModalOpen(true);
  }

  function openEditRuleModal(rule: CustomRuleRow): void {
    setEditingRule(rule);
    setRuleFormError(null);
    setRuleForm({
      id: rule.id,
      name: rule.name,
      category: rule.category,
      paths: rule.paths.join(";\n"),
      pattern: rule.pattern ?? "",
      safeLevel: rule.safeLevel,
      description: rule.description,
      enabled: rule.enabled
    });
    setIsRuleModalOpen(true);
  }

  async function submitRuleForm(): Promise<void> {
    const api = getDesktopApi(editingRule ? "更新规则" : "创建规则");
    if (!api) {
      setRuleFormError("未连接桌面桥接，无法保存规则。");
      return;
    }
    const payload: CustomRuleRow = {
      id: ruleForm.id.trim() || `custom-${Date.now()}`,
      name: ruleForm.name.trim(),
      category: ruleForm.category,
      paths: ruleForm.paths.split(/[;\n]/).map((item) => item.trim()).filter((item) => item.length > 0),
      pattern: ruleForm.pattern.trim() || undefined,
      safeLevel: ruleForm.safeLevel,
      description: ruleForm.description.trim() || `${ruleForm.name.trim()} 匹配项`,
      enabled: ruleForm.enabled
    };
    if (!payload.name || payload.paths.length === 0) {
      setRuleFormError("请填写规则名称并至少提供一个路径模式。");
      return;
    }
    try {
      const rows = editingRule
        ? await api.invoke<CustomRuleRow[]>("rules:update-custom", { id: editingRule.id, rule: payload })
        : await api.invoke<CustomRuleRow[]>("rules:create-custom", { rule: payload });
      setCustomRules(rows ?? []);
      setIsRuleModalOpen(false);
      setRuleFormError(null);
      setRuleActionError(null);
    } catch (error) {
      setRuleFormError(error instanceof Error ? error.message : "保存规则失败");
    }
  }

  async function deleteCustomRule(rule: CustomRuleRow): Promise<void> {
    const confirmed = window.confirm(`确认删除规则「${rule.name}」吗？`);
    if (!confirmed) {
      return;
    }
    const api = getDesktopApi("删除规则");
    if (!api) {
      return;
    }
    try {
      const rows = await api.invoke<CustomRuleRow[]>("rules:delete-custom", { id: rule.id });
      setCustomRules(rows ?? []);
      setRuleActionError(null);
    } catch {
      // ignore delete errors in UI
    }
  }

  async function importCustomRules(file: File): Promise<void> {
    const api = getDesktopApi("导入规则");
    if (!api) {
      return;
    }
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as { rules?: CustomRuleRow[] } | CustomRuleRow[];
      const rules = Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
      const rows = await api.invoke<CustomRuleRow[]>("rules:import-custom", { rules });
      setCustomRules(rows ?? []);
      setRuleActionError(null);
    } catch {
      setRuleFormError("导入失败，请检查 JSON 格式。");
      setIsRuleModalOpen(true);
    }
  }

  return (
    <div className="page">
      <PageHead title="设置" subtitle="自定义系统盘清理、监控与迁移行为，打造更贴合你的使用体验" />
      {ruleActionError && <div className="notice warning">{ruleActionError}</div>}
      <div className="grid settings-grid">
        <div className="stack">
          <section className="card">
            <div className="card-title">扫描设置</div>
            <div className="form-grid">
              <div className="form-row">
                <label>扫描深度</label>
                <select className="text-input" value={scanDepth} onChange={(event) => onSettingChange("scan.depth", event.target.value)}>
                  <option value="1">1 层（极快，仅顶层目录）</option>
                  <option value="3">3 层（快速）</option>
                  <option value="5">5 层（推荐，覆盖 AppData 应用级）</option>
                  <option value="8">8 层（深入，覆盖缓存子目录）</option>
                  <option value="10">10 层（更深）</option>
                  <option value="0">无限制（仅 MFT 引擎高效，Walk 引擎自动限制 10 层）</option>
                </select>
              </div>
              <div className="form-row">
                <label>大文件阈值</label>
                <input
                  className="text-input"
                  type="number"
                  min={10}
                  max={10240}
                  value={thresholdMbInput}
                  onChange={(event) => setThresholdMbInput(event.target.value)}
                  onBlur={commitThresholdMb}
                />
              </div>
              <div className="form-row">
                <label>优先引擎</label>
                <select className="text-input" value={preferredEngine} onChange={(event) => onSettingChange("scan.preferredEngine", event.target.value)}>
                  <option value="auto">Everything &gt; MFT &gt; os.walk</option>
                  <option value="mft">仅 MFT</option>
                  <option value="walk">仅 os.walk</option>
                </select>
              </div>
              <div className="setting-toggle">
                <span>压缩包内容</span>
                <button className={`toggle ${includeArchives ? "on" : ""}`} onClick={() => onSettingChange("scan.includeArchives", !includeArchives)} />
              </div>
            </div>
          </section>
          {!adminGranted && <div className="notice warning">未授予管理员权限时，MFT 直读扫描会灰显并自动回退到 os.walk。</div>}
          <section className="card">
            <div className="card-title">迁移设置</div>
            <div className="form-grid">
              <div className="form-row">
                <label>默认目标路径</label>
                <div className="migrate-input-row">
                  <input className="text-input" value={targetPathInput} onChange={(event) => setTargetPathInput(event.target.value)} onBlur={commitTargetPath} />
                  <button
                    className="secondary-btn"
                    onClick={async () => {
                      const selected = await onPickDirectory(targetPathInput);
                      if (!selected) {
                        return;
                      }
                      setTargetPathInput(selected);
                      onSettingChange("migrate.defaultTargetPath", selected);
                    }}
                  >
                    选择
                  </button>
                </div>
              </div>
              <div className="form-row">
                <label>保留备份天数</label>
                <input
                  className="text-input"
                  type="number"
                  min={1}
                  max={365}
                  value={migrateBackupDaysInput}
                  onChange={(event) => setMigrateBackupDaysInput(event.target.value)}
                  onBlur={commitMigrateBackupDays}
                />
              </div>
              <div className="setting-toggle">
                <span>迁移时自动关闭占用进程</span>
                <button className={`toggle ${migrateCheckLock ? "on" : ""}`} onClick={() => onSettingChange("migrate.checkProcessLock", !migrateCheckLock)} />
              </div>
            </div>
          </section>
          <section className="card" style={{ flex: 1 }}>
            <div className="card-title">数据库状态</div>
            <div className="legend">
              <span>SQLite：<b>{dbSummary.available ? "已初始化" : "不可用"}</b></span>
              <span>数据库版本：<b>{dbSummary.version}</b></span>
              <span>规则库版本：<b>{dbSummary.rulesVersion}</b></span>
              <span>规则更新时间：<b>{dbSummary.rulesLastUpdated ? formatActivityTime(dbSummary.rulesLastUpdated) : "未记录"}</b></span>
              <span>最近备份：<b>{dbSummary.latestBackupAt ? formatActivityTime(dbSummary.latestBackupAt) : "等待首次备份"}</b></span>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="card">
            <div className="card-title">清理设置</div>
            <div className="form-grid">
              <div className="form-row">
                <label>日志保留天数</label>
                <input
                  className="text-input"
                  type="number"
                  min={1}
                  max={365}
                  value={cleanupLogDaysInput}
                  onChange={(event) => setCleanupLogDaysInput(event.target.value)}
                  onBlur={commitCleanupLogDays}
                />
              </div>
              <div className="form-row">
                <label>默认勾选策略</label>
                <select className="text-input" value={cleanupDefaultSelection} onChange={(event) => onSettingChange("cleanup.defaultSelection", event.target.value)}>
                  <option value="recommended">推荐清理项</option>
                  <option value="safe_only">仅安全项</option>
                  <option value="all">全部命中项</option>
                </select>
              </div>
              <div className="form-row">
                <label>风险确认</label>
                <select className="text-input" value={cleanupRiskConfirm} onChange={(event) => onSettingChange("cleanup.riskConfirm", event.target.value)}>
                  <option value="high_only">仅高风险确认</option>
                  <option value="all">全部确认</option>
                </select>
              </div>
              <div className="setting-toggle">
                <span>清理前创建还原点</span>
                <button className={`toggle ${cleanupCreateRestore ? "on" : ""}`} onClick={() => onSettingChange("cleanup.createRestorePoint", !cleanupCreateRestore)} />
              </div>
            </div>
          </section>
          <section className="card">
            <div className="card-title">启动与托盘</div>
            <div className="setting-toggle">
              <span>开机自启</span>
              <button className={`toggle ${trayAutoStart ? "on" : ""}`} onClick={() => onSettingChange("tray.autoStart", !trayAutoStart)} />
            </div>
            <p className="muted-line">系统启动项：{autoStartRegistered ? "已注册" : "未注册"}{autoStartRegistered && !autoStartReady ? "（等待系统刷新）" : ""}</p>
            {autoStartLastBootLaunchAt && <p className="muted-line">最近疑似开机自启启动：{formatActivityTime(autoStartLastBootLaunchAt)}</p>}
            <div className="setting-toggle">
              <span>最小化到托盘</span>
              <button className={`toggle ${trayMinimizeToTray ? "on" : ""}`} onClick={() => onSettingChange("tray.minimizeToTray", !trayMinimizeToTray)} />
            </div>
            <div className="setting-toggle">
              <span>关闭到托盘</span>
              <button className={`toggle ${trayCloseToTray ? "on" : ""}`} onClick={() => onSettingChange("tray.closeToTray", !trayCloseToTray)} />
            </div>
            <div className="setting-toggle">
              <span>扫描时托盘动画</span>
              <button className={`toggle ${trayScanAnimation ? "on" : ""}`} onClick={() => onSettingChange("tray.scanAnimation", !trayScanAnimation)} />
            </div>
            <div className="setting-toggle">
              <span>每日监控</span>
              <button className={`toggle ${monitorEnabled ? "on" : ""}`} onClick={onToggleMonitor} aria-label="每日监控" />
            </div>
          </section>
          <section className="card" style={{ flex: 1 }}>
            <div className="card-title">缓存目录</div>
            <div className="legend">
              <span style={{ fontFamily: "monospace", fontSize: 11, wordBreak: "break-all" }}>{dbSummary.appDir || "—"}</span>
              <span className="muted-line" style={{ fontSize: 11 }}>规则文件与注册表备份随软件安装位置存放</span>
            </div>
            <button className="link-btn" style={{ marginTop: 8 }} onClick={() => {
              const api = window.cDriveCleaner;
              if (api && dbSummary.appDir) void api.invoke("shell:show-in-folder", { path: dbSummary.appDir });
            }}>
              打开文件夹
            </button>
          </section>
        </div>
        <aside className="right-list">
          <section className="card">
            <div className="card-title">关于应用</div>
            <div className="about-row"><div className="logo small" /><div><b>{appMeta.name}</b><span>v{appMeta.version}</span></div></div>
            <p className="muted-line">{appMeta.description}</p>
          </section>
          <section className="card danger-zone">
            <div className="card-title">危险操作</div>
            <button className="link-btn danger" onClick={onResetSettings}><Power size={15} /> 重置所有设置</button>
            <p>将所有设置恢复为默认值。</p>
          </section>
        </aside>
      </div>

      <section className="card rules-card">
        <div className="card-title">
          <span>自定义垃圾规则</span>
          <div className="button-row">
            <button className="secondary-btn" onClick={openCreateRuleModal}>新增规则</button>
            <label className="secondary-btn ok file-btn">
              导入规则
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    return;
                  }
                  void importCustomRules(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>规则名称</th>
              <th>分类</th>
              <th>路径模式</th>
              <th>safe_level</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {customRules.map((rule) => (
              <tr key={rule.id}>
                <td>{rule.name}</td>
                <td>{categoryLabel(rule.category)}</td>
                <td title={rule.paths.join("; ")}>{rule.paths.join("; ")}</td>
                <td>{rule.safeLevel}</td>
                <td>{rule.enabled ? "启用" : "禁用"}</td>
                <td>
                  <button className="link-btn" onClick={() => openEditRuleModal(rule)}>编辑</button>
                  <button className="link-btn danger" onClick={() => void deleteCustomRule(rule)}>删除</button>
                </td>
              </tr>
            ))}
            {customRules.length === 0 && (
              <tr>
                <td colSpan={6} className="table-empty">暂无自定义规则</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {isRuleModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="card-title">{editingRule ? "编辑规则" : "新增规则"}</div>
            <div className="form-grid">
              <div className="form-row">
                <label>规则ID</label>
                <input className="text-input" value={ruleForm.id} onChange={(event) => setRuleForm((current) => ({ ...current, id: event.target.value }))} />
              </div>
              <div className="form-row">
                <label>名称</label>
                <input className="text-input" value={ruleForm.name} onChange={(event) => setRuleForm((current) => ({ ...current, name: event.target.value }))} />
              </div>
              <div className="form-row">
                <label>分类</label>
                <select className="text-input" value={ruleForm.category} onChange={(event) => setRuleForm((current) => ({ ...current, category: event.target.value as JunkCategory }))}>
                  <option value="system_cache">系统缓存</option>
                  <option value="browser">浏览器缓存</option>
                  <option value="app_cache">应用缓存</option>
                  <option value="dev_cache">开发缓存</option>
                  <option value="temp_files">临时文件</option>
                  <option value="recycle_bin">回收站</option>
                  <option value="logs">日志文件</option>
                  <option value="update_residual">更新残留</option>
                </select>
              </div>
              <div className="form-row">
                <label>路径模式</label>
                <textarea className="text-input multiline" value={ruleForm.paths} onChange={(event) => setRuleForm((current) => ({ ...current, paths: event.target.value }))} />
              </div>
              <div className="form-row">
                <label>文件模式</label>
                <input className="text-input" value={ruleForm.pattern} onChange={(event) => setRuleForm((current) => ({ ...current, pattern: event.target.value }))} />
              </div>
              <div className="form-row">
                <label>safe_level</label>
                <select className="text-input" value={ruleForm.safeLevel} onChange={(event) => setRuleForm((current) => ({ ...current, safeLevel: event.target.value as SafeLevel }))}>
                  <option value="safe">safe</option>
                  <option value="caution">caution</option>
                  <option value="danger">danger</option>
                </select>
              </div>
              <div className="form-row">
                <label>描述</label>
                <input className="text-input" value={ruleForm.description} onChange={(event) => setRuleForm((current) => ({ ...current, description: event.target.value }))} />
              </div>
              <div className="setting-toggle">
                <span>启用规则</span>
                <button className={`toggle ${ruleForm.enabled ? "on" : ""}`} onClick={() => setRuleForm((current) => ({ ...current, enabled: !current.enabled }))} />
              </div>
            </div>
            {ruleFormError && <div className="notice warning">{ruleFormError}</div>}
            <div className="step-actions">
              <button className="secondary-btn" onClick={() => setIsRuleModalOpen(false)}>取消</button>
              <button className="primary-btn" onClick={() => void submitRuleForm()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
