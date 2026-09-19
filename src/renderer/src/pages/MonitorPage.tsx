import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Bell, Camera, ChevronRight, Database, RefreshCw, TrendingDown } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { Alert, GrowthItem, HealthScore, Snapshot } from "../../../shared/types";
import type { PageId } from "../types";
import { formatBytes, formatDate, formatActivityTime, healthGradeColor, healthGradeClass, healthGradeLabel } from "../utils/format";
import { ControlCard, PageHead, RangeChips } from "../components/ui";

export function MonitorPage({
  monitorEnabled,
  monitorDailyTime,
  monitorThresholdBytes,
  monitorThresholdPercent,
  monitorNotifyToast,
  monitorNotifyLog,
  monitorNotifyInApp,
  growthRows,
  alerts,
  alertHistory,
  healthScore,
  onToggleMonitor,
  onDailyTimeChange,
  onThresholdGbChange,
  onThresholdPercentChange,
  onToggleNotifyMode,
  onNavigate
}: {
  monitorEnabled: boolean;
  monitorDailyTime: string;
  monitorThresholdBytes: number;
  monitorThresholdPercent: number;
  monitorNotifyToast: boolean;
  monitorNotifyLog: boolean;
  monitorNotifyInApp: boolean;
  growthRows: GrowthItem[];
  alerts: Alert[];
  alertHistory: Alert[];
  healthScore: HealthScore;
  onToggleMonitor: () => void;
  onDailyTimeChange: (value: string) => void;
  onThresholdGbChange: (value: number) => void;
  onThresholdPercentChange: (value: number) => void;
  onToggleNotifyMode: (mode: "toast" | "log" | "inApp") => void;
  onNavigate: (page: PageId) => void;
}): JSX.Element {
  const [editingTime, setEditingTime] = useState(false);
  const [isTakingSnapshot, setIsTakingSnapshot] = useState(false);
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [timeInput, setTimeInput] = useState(monitorDailyTime);
  const [thresholdGbInput, setThresholdGbInput] = useState((monitorThresholdBytes / 1024 ** 3).toFixed(2));
  const [thresholdPercentInput, setThresholdPercentInput] = useState(String(monitorThresholdPercent));

  useEffect(() => {
    setTimeInput(monitorDailyTime);
  }, [monitorDailyTime]);

  useEffect(() => {
    setThresholdGbInput((monitorThresholdBytes / 1024 ** 3).toFixed(2));
  }, [monitorThresholdBytes]);

  useEffect(() => {
    setThresholdPercentInput(String(monitorThresholdPercent));
  }, [monitorThresholdPercent]);

  const [diskTrendRange, setDiskTrendRange] = useState<7 | 30 | 90>(7);
  const [dirTrendRange, setDirTrendRange] = useState<7 | 30 | 90>(30);
  const [diskTrendRows, setDiskTrendRows] = useState<Array<{ date: string; used: number; free: number }>>([]);
  const [dirOptions, setDirOptions] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState("");
  const [dirTrendRows, setDirTrendRows] = useState<Array<{ date: string; sizeGb: number }>>([]);
  const [dirGrowthStreak, setDirGrowthStreak] = useState(0);

  useEffect(() => {
    const candidates = new Set<string>(growthRows.map((item) => item.dirName));
    const options = [...candidates];
    setDirOptions(options);
    if (!selectedDir || !options.includes(selectedDir)) {
      setSelectedDir(options[0] ?? "");
    }
  }, [growthRows, selectedDir]);

  useEffect(() => {
    let mounted = true;
    const api = window.cDriveCleaner;
    if (!api) {
      setDiskTrendRows([]);
      return () => {
        mounted = false;
      };
    }
    void api
      .invoke<Snapshot[]>("monitor:get-snapshots", { days: diskTrendRange })
      .then((rows) => {
        if (!mounted) {
          return;
        }
        if (rows.length === 0) {
          setDiskTrendRows([]);
          return;
        }
        const mapped = rows.map((snapshot) => ({
          date: formatDate(snapshot.takenAt),
          used: Number((snapshot.usedSize / 1024 ** 3).toFixed(2)),
          free: Number((snapshot.freeSize / 1024 ** 3).toFixed(2))
        }));
        setDiskTrendRows(mapped);
        const latest = rows[rows.length - 1];
        if (latest?.dirs?.length) {
          setDirOptions((current) => {
            const merged = new Set<string>([...current, ...latest.dirs.map((dir) => dir.name)]);
            return [...merged];
          });
        }
      })
      .catch(() => {
        if (mounted) {
          setDiskTrendRows([]);
        }
      });
    return () => {
      mounted = false;
    };
  }, [diskTrendRange]);

  useEffect(() => {
    let mounted = true;
    const api = window.cDriveCleaner;
    if (!api) {
      setDirTrendRows([]);
      setDirGrowthStreak(0);
      return () => {
        mounted = false;
      };
    }
    if (!selectedDir) {
      setDirTrendRows([]);
      setDirGrowthStreak(0);
      return () => {
        mounted = false;
      };
    }
    void api
      .invoke<Array<{ takenAt: string; dirName: string; size: number }>>("monitor:get-dir-history", {
        dirName: selectedDir,
        days: dirTrendRange
      })
      .then((rows) => {
        if (!mounted) {
          return;
        }
        const mapped = rows.map((item) => ({
          date: formatDate(item.takenAt),
          sizeGb: Number((item.size / 1024 ** 3).toFixed(2))
        }));
        setDirTrendRows(mapped.length > 0 ? mapped : []);
        let streak = 0;
        for (let index = rows.length - 1; index > 0; index -= 1) {
          if (rows[index].size > rows[index - 1].size) {
            streak += 1;
          } else {
            break;
          }
        }
        setDirGrowthStreak(streak);
      })
      .catch(() => {
        if (!mounted) {
          return;
        }
        setDirTrendRows([]);
        setDirGrowthStreak(0);
      });
    return () => {
      mounted = false;
    };
  }, [dirTrendRange, selectedDir]);

  function submitDailyTime(): void {
    if (!/^\d{2}:\d{2}$/.test(timeInput)) {
      setTimeInput(monitorDailyTime);
      setEditingTime(false);
      return;
    }
    setEditingTime(false);
    onDailyTimeChange(timeInput);
  }

  function submitThresholdGb(): void {
    const parsed = Number(thresholdGbInput);
    if (!Number.isFinite(parsed)) {
      setThresholdGbInput((monitorThresholdBytes / 1024 ** 3).toFixed(2));
      return;
    }
    onThresholdGbChange(parsed);
  }

  function submitThresholdPercent(): void {
    const parsed = Number(thresholdPercentInput);
    if (!Number.isFinite(parsed)) {
      setThresholdPercentInput(String(monitorThresholdPercent));
      return;
    }
    onThresholdPercentChange(parsed);
  }

  async function takeSnapshot(): Promise<void> {
    const api = window.cDriveCleaner;
    if (!api || isTakingSnapshot) {
      return;
    }
    setIsTakingSnapshot(true);
    setSnapshotMessage(null);
    try {
      await api.invoke("monitor:take-snapshot");
      setSnapshotMessage("快照已保存，图表数据将在刷新后更新。");
      const [newSnapshots] = await Promise.all([
        api.invoke<Snapshot[]>("monitor:get-snapshots", { days: diskTrendRange })
      ]);
      if (newSnapshots.length > 0) {
        const mapped = newSnapshots.map((snapshot) => ({
          date: formatDate(snapshot.takenAt),
          used: Number((snapshot.usedSize / 1024 ** 3).toFixed(2)),
          free: Number((snapshot.freeSize / 1024 ** 3).toFixed(2))
        }));
        setDiskTrendRows(mapped);
      }
    } catch (error) {
      setSnapshotMessage(error instanceof Error ? error.message : "快照失败，请重试");
    } finally {
      setIsTakingSnapshot(false);
    }
  }

  function openSuggestionTarget(suggestion: string): void {
    if (suggestion.includes("迁移")) {
      onNavigate("migrate");
      return;
    }
    onNavigate("junk");
  }

  const forecastDays = useMemo(() => {
    if (diskTrendRows.length < 3) {
      return null;
    }
    const recent = diskTrendRows.slice(-Math.min(7, diskTrendRows.length));
    const totalFreeGb = recent[recent.length - 1].free;
    if (totalFreeGb <= 0) {
      return 0;
    }
    const growths = recent.slice(1).map((row, index) => row.used - recent[index].used);
    const validGrowths = growths.filter((g) => g > 0);
    if (validGrowths.length === 0) {
      return null;
    }
    const avgDailyGrowthGb = validGrowths.reduce((sum, g) => sum + g, 0) / validGrowths.length;
    if (avgDailyGrowthGb <= 0) {
      return null;
    }
    return Math.floor(totalFreeGb / avgDailyGrowthGb);
  }, [diskTrendRows]);

  const growthTopRows = growthRows.slice(0, 10);
  const healthReady =
    healthScore.score > 0
    || healthScore.details.freePercent > 0
    || healthScore.details.junkPercent > 0
    || healthScore.details.largeFileSize > 0
    || healthScore.details.abnormalDirCount > 0
    || healthScore.details.fragmentPercent > 0;

  return (
    <div className="page">
      <PageHead
        title="每日监控与历史趋势"
        subtitle="实时监控磁盘变化，掌握增长趋势，及时发现异常"
        right={
          <button
            className="secondary-btn"
            onClick={() => void takeSnapshot()}
            disabled={isTakingSnapshot}
            title="拍摄当前磁盘状态快照，立即写入历史数据"
          >
            <Camera size={15} />
            {isTakingSnapshot ? "拍摄中..." : "立即拍摄快照"}
          </button>
        }
      />
      {snapshotMessage && (
        <div className="notice info">{snapshotMessage}</div>
      )}
      <div className="grid cols-4">
        <ControlCard title="总开关" detail="开启后自动监控磁盘变化">
          <button className={`toggle ${monitorEnabled ? "on" : ""}`} onClick={onToggleMonitor} aria-label="切换监控" />
          <b className={monitorEnabled ? "ok-text" : "muted"}>{monitorEnabled ? "已开启" : "已关闭"}</b>
        </ControlCard>
        <ControlCard title="每日扫描时间" detail="每天自动扫描系统盘">
          {editingTime ? (
            <input
              className="control-input"
              type="time"
              value={timeInput}
              onChange={(event) => setTimeInput(event.target.value)}
              onBlur={submitDailyTime}
            />
          ) : (
            <strong className="control-value">{monitorDailyTime}</strong>
          )}
          <button
            className="secondary-btn small"
            onClick={() => {
              if (editingTime) {
                submitDailyTime();
                return;
              }
              setEditingTime(true);
            }}
          >
            {editingTime ? "完成" : "修改"}
          </button>
        </ControlCard>
        <ControlCard title="增长提醒阈值" detail="单目录单日增长超过阈值时提醒">
          <input
            className="control-input compact"
            type="number"
            min={0.1}
            max={128}
            step={0.1}
            value={thresholdGbInput}
            onChange={(event) => setThresholdGbInput(event.target.value)}
            onBlur={submitThresholdGb}
          />
          <span className="muted">GB</span>
          <input
            className="control-input compact"
            type="number"
            min={1}
            max={100}
            step={1}
            value={thresholdPercentInput}
            onChange={(event) => setThresholdPercentInput(event.target.value)}
            onBlur={submitThresholdPercent}
          />
          <span className="muted">%</span>
        </ControlCard>
        <ControlCard title="通知方式" detail="toast / 日志 / 应用内提醒">
          <div className="notify-icons">
            <button className={`notify-pill ${monitorNotifyToast ? "active" : ""}`} onClick={() => onToggleNotifyMode("toast")} title="Windows Toast">
              <Bell size={15} />
              <span>Toast</span>
            </button>
            <button className={`notify-pill ${monitorNotifyLog ? "active" : ""}`} onClick={() => onToggleNotifyMode("log")} title="写入日志">
              <Database size={15} />
              <span>日志</span>
            </button>
            <button className={`notify-pill ${monitorNotifyInApp ? "active" : ""}`} onClick={() => onToggleNotifyMode("inApp")} title="应用内提醒">
              <Activity size={15} />
              <span>应用内</span>
            </button>
          </div>
        </ControlCard>
      </div>

      <div className="grid cols-2 chart-row">
        <section className="card">
          <div className="card-title">
            <span>系统盘总使用空间 / 剩余空间</span>
            <RangeChips
              active={`${diskTrendRange}天`}
              onSelect={(range) => setDiskTrendRange(Number(range.replace("天", "")) as 7 | 30 | 90)}
            />
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={diskTrendRows}>
                <CartesianGrid stroke="#edf2fa" />
                <XAxis dataKey="date" tick={{ fill: "#6f7b91", fontSize: 12 }} />
                <YAxis tick={{ fill: "#6f7b91", fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="used" stroke="#1769e8" strokeWidth={3} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="free" stroke="#10a66a" strokeWidth={3} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {diskTrendRows.length === 0 && <p className="muted-line">暂无历史快照，等待每日监控或手动触发后生成。</p>}
        </section>
        <section className="card">
          <div className="card-title">
            <span>目录历史增长趋势</span>
            <div className="control-line">
              <select
                className="control-input"
                value={selectedDir}
                onChange={(event) => setSelectedDir(event.target.value)}
                disabled={dirOptions.length === 0}
              >
                {dirOptions.length === 0 && <option value="">暂无可选目录</option>}
                {dirOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <RangeChips
                active={`${dirTrendRange}天`}
                onSelect={(range) => setDirTrendRange(Number(range.replace("天", "")) as 7 | 30 | 90)}
              />
            </div>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dirTrendRows}>
                <CartesianGrid stroke="#edf2fa" />
                <XAxis dataKey="date" tick={{ fill: "#6f7b91", fontSize: 12 }} />
                <YAxis tick={{ fill: "#6f7b91", fontSize: 12 }} />
                <Tooltip />
                <Area type="monotone" dataKey="sizeGb" stroke="#7b61ff" fill="rgba(123,97,255,.14)" strokeWidth={3} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {dirTrendRows.length === 0 && <p className="muted-line">暂无目录历史数据。</p>}
          <p className="muted-line">连续增长天数：{dirGrowthStreak} 天</p>
        </section>
      </div>

      <div className="grid monitor-bottom">
        <section className="card">
          <div className="card-title">
            <span>异常增长目录 Top 10</span>
            <button className="link-btn" onClick={() => onNavigate("scan")}>
              查看完整 Top 10
              <ChevronRight size={15} />
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>排名</th>
                <th>目录</th>
                <th>今日增长</th>
                <th>增长率</th>
                <th>建议操作</th>
              </tr>
            </thead>
            <tbody>
              {growthTopRows.map((item, index) => {
                const growthPercent = item.rate * 100;
                const level = growthPercent > 10 ? "danger" : growthPercent >= 5 ? "caution" : "safe";
                return (
                  <tr key={`${item.dirName}-${index}`}>
                    <td>{index + 1}</td>
                    <td title={item.dirName}>{item.dirName}</td>
                    <td>{formatBytes(item.delta)}</td>
                    <td>
                      <span className={`badge ${level}`}>{growthPercent.toFixed(1)}%</span>
                    </td>
                    <td>
                      <button className="chip action-chip" onClick={() => openSuggestionTarget(item.suggestion)}>
                        {item.suggestion}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {growthTopRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="table-empty">
                    暂无异常增长目录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="card-title">
            <span>最近告警</span>
            <button className="link-btn" onClick={() => setShowAllAlerts(true)}>
              更多
              <ChevronRight size={15} />
            </button>
          </div>
          {alerts.map((alert) => (
            <button className="insight" key={alert.id} onClick={() => setShowAllAlerts(true)}>
              <span className={`metric-icon small ${alert.severity === "critical" ? "red-bg" : "orange-bg"}`}>
                <AlertTriangle size={18} />
              </span>
              <span>
                <b>{alert.title}</b>
                <small>{alert.description}</small>
              </span>
              <small className="muted">{formatActivityTime(alert.createdAt)}</small>
            </button>
          ))}
          {alerts.length === 0 && <p className="muted-line">暂无告警记录。</p>}
        </section>
        <section className="card health-overview">
          <div className="card-title">
            <span>空间容量预测</span>
            <button className="link-btn" onClick={() => void takeSnapshot()}>
              <RefreshCw size={13} /> 刷新
            </button>
          </div>
          {forecastDays === null ? (
            <p className="muted-line">需至少 3 条历史快照才能预测。先拍摄几次快照或等待每日监控积累数据。</p>
          ) : forecastDays <= 0 ? (
            <div className="notice warning">
              <TrendingDown size={15} /> C 盘可用空间即将耗尽，请立即清理！
            </div>
          ) : (
            <>
              <strong className={forecastDays < 30 ? "warn-text" : forecastDays < 7 ? "danger-text" : "ok-text"} style={{ fontSize: "2rem" }}>
                {forecastDays} 天
              </strong>
              <span className="muted">按近期平均增速，预计剩余可用时间</span>
              <div className="legend">
                <span>当前增速（日均）：<b>{diskTrendRows.length >= 2 ? `+${((diskTrendRows[diskTrendRows.length - 1]?.used ?? 0) - (diskTrendRows[diskTrendRows.length - 2]?.used ?? 0)).toFixed(2)} GB` : "--"}</b></span>
                <span>当前剩余空间：<b>{diskTrendRows.length > 0 ? `${(diskTrendRows[diskTrendRows.length - 1]?.free ?? 0).toFixed(2)} GB` : "--"}</b></span>
              </div>
              {forecastDays < 30 && (
                <button className="secondary-btn" onClick={() => onNavigate("junk")}>
                  前往清理
                </button>
              )}
            </>
          )}
        </section>
        <section className="card health-overview">
          <div className="card-title">磁盘健康概览</div>
          <div
            className="mini-donut health"
            style={{
              background: `conic-gradient(${healthReady ? healthGradeColor(healthScore.grade) : "#c8d2e4"} 0 ${healthReady ? healthScore.score : 0}%, #e8edf5 ${healthReady ? healthScore.score : 0}% 100%)`
            }}
          />
          <strong>{healthReady ? `${healthScore.score}/100` : "待评估"}</strong>
          <span className={healthGradeClass(healthScore.grade)}>{healthReady ? healthGradeLabel(healthScore.grade) : "请先生成监控快照"}</span>
          <div className="legend">
            <span>剩余空间：<b>{healthReady ? `${(healthScore.details.freePercent * 100).toFixed(1)}%` : "--"}</b></span>
            <span>文件碎片率：<b>{healthReady ? `${(healthScore.details.fragmentPercent * 100).toFixed(1)}%` : "--"}</b></span>
            <span>大文件占用：<b>{healthReady ? formatBytes(healthScore.details.largeFileSize) : "--"}</b></span>
            <span>异常增长目录：<b>{healthReady ? `${healthScore.details.abnormalDirCount} 个` : "--"}</b></span>
          </div>
        </section>
      </div>

      {showAllAlerts && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="card-title">告警历史</div>
            <div className="legend">
              {alertHistory.map((alert) => (
                <span key={alert.id}>
                  <b>{formatActivityTime(alert.createdAt)}</b> · {alert.description}
                </span>
              ))}
              {alertHistory.length === 0 && <span>暂无告警历史。</span>}
            </div>
            <div className="step-actions">
              <button className="secondary-btn" onClick={() => setShowAllAlerts(false)}>
                关闭
              </button>
              <button className="primary-btn" onClick={() => setShowAllAlerts(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
