import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Eraser,
  FileSearch,
  Folder,
  HardDrive,
  Settings,
  ShieldCheck,
  Trash2
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  CleanupLog,
  CleanupPlan,
  CleanupProgress,
  CleanupReport,
  JunkCategory,
  JunkItem,
  JunkScanResult,
  SafeLevel
} from "../../../shared/types";
import type { JunkViewMode, Metric } from "../types";
import type { JunkScanOptions, JunkScanPreset } from "../utils/junk";
import { formatBytes, formatActivityTime, categoryLabel } from "../utils/format";
import { junkOptionsFromPreset, inferJunkSoftware, mergeSafeLevel } from "../utils/junk";
import { Badge, DataTable, MetricGrid, PageHead, Progress } from "../components/ui";

const WPS_SECTIONS = [
  { key: "common_software", title: "常用软件", subtitle: "软件使用过程中产生的临时文件，可以删除以节省空间" },
  { key: "wechat_cleanup", title: "微信电脑版专清", subtitle: "过期的聊天视频图片可删除" },
  { key: "qq_cleanup", title: "QQ/TIM电脑版专清", subtitle: "过期的聊天视频图片可删除" },
  { key: "windows_cleanup", title: "Windows可清理内容", subtitle: "删除后不影响系统正常使用" },
  { key: "dev_cache", title: "开发者缓存", subtitle: "开发工具产生的缓存文件" }
] as const;

type FixedItem = { winKey: string; label: string; emoji: string; bg: string };

// WPS微信固定6项
const WPS_WECHAT_FIXED_ITEMS: FixedItem[] = [
  { winKey: "wechat-logs",   label: "日志文件",   emoji: "📋", bg: "#f59e42" },
  { winKey: "wechat-cache",  label: "缓存文件",   emoji: "💾", bg: "#4a90d9" },
  { winKey: "wechat-images", label: "聊天图片",   emoji: "🖼️", bg: "#9b59b6" },
  { winKey: "wechat-videos", label: "聊天视频",   emoji: "🎬", bg: "#e74c3c" },
  { winKey: "wechat-files",  label: "接收的文件",  emoji: "📥", bg: "#27ae60" },
  { winKey: "wechat-backup", label: "微信备份",   emoji: "📦", bg: "#8e6bbf" },
];

// WPS QQ固定6项
const WPS_QQ_FIXED_ITEMS: FixedItem[] = [
  { winKey: "qq-logs",   label: "日志文件",   emoji: "📋", bg: "#f59e42" },
  { winKey: "qq-cache",  label: "缓存文件",   emoji: "💾", bg: "#4a90d9" },
  { winKey: "qq-images", label: "聊天图片",   emoji: "🖼️", bg: "#9b59b6" },
  { winKey: "qq-videos", label: "聊天视频",   emoji: "🎬", bg: "#e74c3c" },
  { winKey: "qq-voice",  label: "聊天语音",   emoji: "🎙️", bg: "#16a085" },
  { winKey: "qq-files",  label: "接收的文件",  emoji: "📥", bg: "#27ae60" },
];

// WPS固定显示的Windows区项目（无论是否扫到都显示，与WPS完全对齐）
const WPS_WINDOWS_FIXED_ITEMS: FixedItem[] = [
  { winKey: "windows-restore",   label: "系统还原点",    emoji: "⏮️",  bg: "#2980b9" },
  { winKey: "windows-patch",     label: "升级补丁备份",  emoji: "🔧",  bg: "#d35400" },
  { winKey: "windows-update",    label: "系统更新缓存",  emoji: "⬇️",  bg: "#2471a3" },
  { winKey: "windows-installer", label: "安装包残留文件", emoji: "📀",  bg: "#7d3c98" },
  { winKey: "windows-old",       label: "旧版系统文件",  emoji: "🗂️",  bg: "#616a6b" },
  { winKey: "windows-hibernate", label: "系统休眠文件",  emoji: "💤",  bg: "#1a5276" },
  { winKey: "windows-pagefile",  label: "转移虚拟内存",  emoji: "🧠",  bg: "#6c3483" },
  { winKey: "windows-memdump",   label: "内存转储文件",  emoji: "💥",  bg: "#c0392b" },
  { winKey: "windows-minidump",  label: "小型转储文件",  emoji: "⚡",  bg: "#b7950b" },
  { winKey: "windows-temp",      label: "临时文件",      emoji: "⏰",  bg: "#117a65" },
  { winKey: "windows-logs",      label: "日志文件",      emoji: "📋",  bg: "#1f618d" },
  { winKey: "windows-cache",     label: "缓存文件",      emoji: "💾",  bg: "#1a6fa3" },
  { winKey: "windows-other",     label: "其它文件",      emoji: "📂",  bg: "#7f8c8d" },
  { winKey: "windows-security",  label: "系统安全中心",  emoji: "🛡️",  bg: "#1e8449" },
  { winKey: "windows-diag",      label: "系统诊断数据",  emoji: "🔬",  bg: "#6e2fa1" },
  { winKey: "windows-dotnet",    label: ".Net框架",      emoji: "⚙️",  bg: "#2e86c1" },
  { winKey: "windows-thumbnail", label: "缩略图缓存",    emoji: "🖼️",  bg: "#8e44ad" },
  { winKey: "windows-recycle",   label: "回收站",        emoji: "🗑️",  bg: "#c0392b" },
];

// Emoji fallbacks for common software when no real icon is found
const EMOJI_FALLBACKS: Record<string, { emoji: string; bg: string }> = {
  // Package managers / dev tools
  "npm":        { emoji: "📦", bg: "#cc3534" },
  "cargo":      { emoji: "🦀", bg: "#ce412b" },
  "yarn":       { emoji: "🧶", bg: "#2c8ebb" },
  "pnpm":       { emoji: "📦", bg: "#f69220" },
  "pip":        { emoji: "🐍", bg: "#3776ab" },
  "nuget":      { emoji: "📦", bg: "#004880" },
  "gradle":     { emoji: "⚙️", bg: "#02303a" },
  "maven":      { emoji: "☕", bg: "#c71a36" },
  "composer":   { emoji: "🎼", bg: "#885630" },
  "gem":        { emoji: "💎", bg: "#cc342d" },
  // IDEs / editors
  "vscode":     { emoji: "💻", bg: "#007acc" },
  "vs code":    { emoji: "💻", bg: "#007acc" },
  "jetbrains":  { emoji: "🧠", bg: "#e8488a" },
  "cursor":     { emoji: "🖱️", bg: "#1a1a1a" },
  "windsurf":   { emoji: "🏄", bg: "#2d7dd2" },
  // Chat / social
  "微信":       { emoji: "💬", bg: "#07c160" },
  "qq":         { emoji: "🐧", bg: "#12b7f5" },
  "飞书":       { emoji: "📝", bg: "#1456f0" },
  "钉钉":       { emoji: "🔔", bg: "#1677ff" },
  "企业微信":   { emoji: "💼", bg: "#07c160" },
  // Video / music
  "抖音":       { emoji: "🎵", bg: "#010101" },
  "哔哩哔哩":   { emoji: "📺", bg: "#fb7299" },
  "qq音乐":     { emoji: "🎵", bg: "#1db954" },
  "网易云音乐": { emoji: "🎶", bg: "#c20c0c" },
  "优酷":       { emoji: "▶️", bg: "#00aeec" },
  // Cloud storage
  "百度网盘":   { emoji: "☁️", bg: "#2932e1" },
  "阿里云盘":   { emoji: "☁️", bg: "#ff6a00" },
  "onedrive":   { emoji: "☁️", bg: "#0078d4" },
  // Games
  "steam":      { emoji: "🎮", bg: "#1b2838" },
  "epic":       { emoji: "🎮", bg: "#2d2d2d" },
  // Browsers
  "chrome":     { emoji: "🌐", bg: "#4285f4" },
  "edge":       { emoji: "🌐", bg: "#0078d7" },
  "firefox":    { emoji: "🦊", bg: "#ff9400" },
};

function getEmojiFallback(key: string, label: string): { emoji: string; bg: string } | null {
  const k = key.toLowerCase();
  const l = label.toLowerCase();
  return EMOJI_FALLBACKS[k] ?? EMOJI_FALLBACKS[l] ?? null;
}

function classifyToWpsSection(groupKey: string, categorySizes: Partial<Record<string, number>>): string {
  const k = groupKey.toLowerCase();
  if (k.startsWith("windows-")) return "windows_cleanup";
  if (k.startsWith("wechat")) return "wechat_cleanup";
  if (k === "wxwork" || k.startsWith("qq") || k === "tim") return "qq_cleanup";
  if (k === "feishu" || k === "feishu-cache" || k === "feishu-logs") return "common_software";
  const dominant = Object.entries(categorySizes).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] ?? "app_cache";
  if (dominant === "dev_cache") return "dev_cache";
  return "common_software";
}

const SCAN_PHASES = [
  "正在扫描系统临时文件...",
  "正在检查软件缓存目录...",
  "正在分析浏览器缓存...",
  "正在识别日志文件...",
  "正在检测微信/QQ 数据...",
  "正在扫描开发者缓存...",
  "正在检查回收站...",
  "正在分析系统日志...",
  "正在识别安装包残留...",
  "即将完成，整理结果中...",
];

function JunkScanningOverlay() {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const DURATION = 28000; // ~28s to reach 92%
    function tick() {
      const elapsed = Date.now() - startRef.current;
      const t = Math.min(elapsed / DURATION, 1);
      // ease-out curve so it slows down toward end
      const pct = Math.round(92 * (1 - Math.pow(1 - t, 2.5)));
      setProgress(pct);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 1) % SCAN_PHASES.length), 2400);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="junk-scanning-overlay">
      <div className="junk-scanning-radar">
        <span className="radar-ring r1" />
        <span className="radar-ring r2" />
        <span className="radar-ring r3" />
        <span className="radar-core"><Eraser size={28} color="#3b82f6" /></span>
      </div>
      <div className="junk-scanning-text">{SCAN_PHASES[phase]}</div>
      <div className="junk-scanning-bar-wrap">
        <div className="junk-scanning-bar" style={{ width: `${progress}%` }} />
        <span className="junk-scanning-pct">{progress}%</span>
      </div>
    </div>
  );
}

export function JunkPage({
  junkResult,
  scanState,
  scanError,
  onStartScan,
  onOpenSettings
}: {
  junkResult: JunkScanResult | null;
  scanState: "idle" | "scanning" | "complete" | "error";
  scanError: string | null;
  onStartScan: (options?: Partial<JunkScanOptions>) => void;
  onOpenSettings: () => void;
}): JSX.Element {
  const [viewMode, setViewMode] = useState<JunkViewMode>("software");
  const [scanPreset, setScanPreset] = useState<JunkScanPreset>("deep");
  const [showScanSettings, setShowScanSettings] = useState(false);
  const [activeLevelFilter, setActiveLevelFilter] = useState<"all" | SafeLevel>("all");
  const [minSizeFilter, setMinSizeFilter] = useState<number>(10485760); // 10 MB default
  const [customSizeInput, setCustomSizeInput] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<JunkCategory>>(new Set());
  const [selectedSoftwareKey, setSelectedSoftwareKey] = useState<string | null>(null);
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(null);
  const [itemFileList, setItemFileList] = useState<Array<{ name: string; size: number; type: "file" | "dir"; count?: number }>>([]);
  const [itemFileListPartial, setItemFileListPartial] = useState(false);
  const [itemFileListLoading, setItemFileListLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [junkScrollTop, setJunkScrollTop] = useState(0);
  const [cleanupPlan, setCleanupPlan] = useState<CleanupPlan | null>(null);
  const [cleanupReport, setCleanupReport] = useState<CleanupReport | null>(null);
  const [cleanupProgress, setCleanupProgress] = useState<CleanupProgress | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [showFailureDetails, setShowFailureDetails] = useState(false);
  const [lockerProcesses, setLockerProcesses] = useState<Array<{ pid: number; name: string; restartable: boolean; paths: string[] }>>([]);
  const [isResolvingLocks, setIsResolvingLocks] = useState(false);
  const [lockRetryResult, setLockRetryResult] = useState<{ deleted: number; failed: number } | null>(null);
  const [cleanedItemPaths, setCleanedItemPaths] = useState<Set<string>>(new Set());
  const [cleanupLogs, setCleanupLogs] = useState<CleanupLog[]>([]);
  const [showAllCleanupLogs, setShowAllCleanupLogs] = useState(false);
  const [expandedCleanupLogIds, setExpandedCleanupLogIds] = useState<Set<number>>(new Set());

  const groups = useMemo(
    () => (junkResult?.groups ?? []).map((g) => ({
      ...g,
      items: g.items.filter((item) => !cleanedItemPaths.has(item.path))
    })).filter((g) => g.items.length > 0),
    [junkResult, cleanedItemPaths]
  );
  const allEntries = useMemo(
    () =>
      groups.flatMap((group) =>
        group.items.map((item) => ({
          group,
          item,
          key: `${group.category}::${item.ruleName}::${item.path}`
        }))
      ),
    [groups]
  );

  useEffect(() => {
    const rawGroups = junkResult?.groups ?? [];
    const rawEntries = rawGroups.flatMap((group) =>
      group.items.map((item) => ({ group, item, key: `${group.category}::${item.ruleName}::${item.path}` }))
    );
    setExpandedGroups(new Set(rawGroups.map((g) => g.category)));
    setSelectedItems(
      Object.fromEntries(rawEntries.map((entry) => [entry.key, entry.item.safeLevel !== "danger" && entry.item.category !== "downloads"]))
    );
    setActiveLevelFilter("all");
    setJunkScrollTop(0);
    setCleanupPlan(null);
    setCleanupReport(null);
    setCleanupProgress(null);
    setShowFailureDetails(false);
    setLockerProcesses([]);
    setLockRetryResult(null);
    setCleanedItemPaths(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [junkResult?.scannedAt]);

  useEffect(() => {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    return api.on<CleanupProgress>("cleanup:progress", (progress) => setCleanupProgress(progress));
  }, []);

  useEffect(() => {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    void api
      .invoke<CleanupLog[]>("cleanup:get-logs", { limit: showAllCleanupLogs ? 200 : 10 })
      .then((logs) => setCleanupLogs(logs))
      .catch(() => setCleanupLogs([]));
  }, [showAllCleanupLogs, cleanupReport?.deletedCount, cleanupReport?.failedCount, cleanupReport?.durationMs]);

  const sumByLevel = (level: "safe" | "caution" | "danger") =>
    groups
      .flatMap((group) => group.items)
      .filter((item) => item.safeLevel === level)
      .reduce(
        (result, item) => ({
          size: result.size + item.size,
          count: result.count + (item.count ?? 0)
        }),
        { size: 0, count: 0 }
      );
  const safe = sumByLevel("safe");
  const caution = sumByLevel("caution");
  const danger = sumByLevel("danger");
  const selectedEntries = allEntries.filter((entry) => selectedItems[entry.key]);
  const selectedSize = selectedEntries.reduce((sum, entry) => sum + entry.item.size, 0);
  const selectedCount = selectedEntries.reduce((sum, entry) => sum + (entry.item.count ?? 0), 0);
  const allCount = safe.count + caution.count + danger.count;
  const filteredGroups = groups
    .map((group) => {
      const entries = group.items
        .map((item) => ({
          item,
          key: `${group.category}::${item.ruleName}::${item.path}`
        }))
        .filter((entry) => activeLevelFilter === "all" || entry.item.safeLevel === activeLevelFilter)
        .filter((entry) => entry.item.size >= minSizeFilter);
      return {
        group,
        entries,
        count: entries.reduce((sum, entry) => sum + (entry.item.count ?? 0), 0),
        size: entries.reduce((sum, entry) => sum + entry.item.size, 0)
      };
    })
    .filter((entry) => entry.entries.length > 0);

  // Count hidden items due to size filter (for hint display)
  const hiddenSoftwareCount = minSizeFilter > 0
    ? allEntries.reduce((acc, entry) => {
        const meta = inferJunkSoftware(entry.item);
        if (
          (activeLevelFilter === "all" || entry.item.safeLevel === activeLevelFilter) &&
          entry.item.size < minSizeFilter
        ) {
          acc.add(meta.key);
        }
        return acc;
      }, new Set<string>()).size
    : 0;

  const MIN_SIZE_OPTIONS: Array<{ label: string; value: number }> = [
    { label: "全部", value: 0 },
    { label: "> 100 KB", value: 102400 },
    { label: "> 1 MB", value: 1048576 },
    { label: ">= 10 MB", value: 10485760 },
  ];

  function parseCustomSize(input: string): number | null {
    const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] ?? "MB").toUpperCase();
    const mult: Record<string, number> = { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
    return Math.round(n * (mult[unit] ?? 1048576));
  }

  function applyCustomSize(): void {
    const v = parseCustomSize(customSizeInput);
    if (v !== null) setMinSizeFilter(v);
  }

  const isCustomSize = !MIN_SIZE_OPTIONS.some((o) => o.value === minSizeFilter);

  const softwareGroups = useMemo(() => {
    const buckets = new Map<
      string,
      {
        key: string;
        label: string;
        icon: LucideIcon; // eslint-disable-line @typescript-eslint/no-unused-vars
        tone: Metric["tone"];
        size: number;
        count: number;
        safeLevel: SafeLevel;
        keys: string[];
        items: Array<{ key: string; item: JunkItem }>;
        detectPath?: string;
        categorySizes: Partial<Record<string, number>>;
      }
    >();
    for (const entry of allEntries) {
      if (activeLevelFilter !== "all" && entry.item.safeLevel !== activeLevelFilter) {
        continue;
      }
      const meta = inferJunkSoftware(entry.item);
      const current = buckets.get(meta.key);
      if (!current) {
        buckets.set(meta.key, {
          key: meta.key,
          label: meta.label,
          icon: meta.icon,
          tone: meta.tone,
          size: entry.item.size,
          count: entry.item.count ?? 0,
          safeLevel: entry.item.safeLevel,
          keys: [entry.key],
          items: [{ key: entry.key, item: entry.item }],
          detectPath: entry.item.detectPath,
          categorySizes: { [entry.item.category]: entry.item.size }
        });
        continue;
      }
      current.size += entry.item.size;
      current.count += entry.item.count ?? 0;
      current.safeLevel = mergeSafeLevel(current.safeLevel, entry.item.safeLevel);
      current.keys.push(entry.key);
      current.items.push({ key: entry.key, item: entry.item });
      if (!current.detectPath && entry.item.detectPath) current.detectPath = entry.item.detectPath;
      current.categorySizes[entry.item.category] = (current.categorySizes[entry.item.category] ?? 0) + entry.item.size;
    }
    // Apply min-size filter: hide cards whose total is below threshold
    // Exclude windows-* keys — they are rendered separately in the fixed Windows section
    return [...buckets.values()]
      .filter((g) => g.size >= minSizeFilter && !g.key.startsWith("windows-") && !g.key.startsWith("wechat") && !g.key.startsWith("qq"))
      .sort((left, right) => right.size - left.size);
  }, [activeLevelFilter, allEntries, minSizeFilter]);

  // WeChat/QQ sections: always show fixed sub-items, no size filter
  const wechatGroupsMap = useMemo(() => {
    const map = new Map<string, typeof softwareGroups[number]>();
    for (const entry of allEntries) {
      const meta = inferJunkSoftware(entry.item);
      if (!meta.key.startsWith("wechat")) continue;
      const cur = map.get(meta.key);
      if (!cur) {
        map.set(meta.key, { key: meta.key, label: meta.label, icon: meta.icon, tone: meta.tone, size: entry.item.size, count: entry.item.count ?? 0, safeLevel: entry.item.safeLevel, keys: [entry.key], items: [{ key: entry.key, item: entry.item }], detectPath: entry.item.detectPath, categorySizes: { [entry.item.category]: entry.item.size } });
      } else {
        cur.size += entry.item.size; cur.count += entry.item.count ?? 0; cur.safeLevel = mergeSafeLevel(cur.safeLevel, entry.item.safeLevel); cur.keys.push(entry.key); cur.items.push({ key: entry.key, item: entry.item }); cur.categorySizes[entry.item.category] = (cur.categorySizes[entry.item.category] ?? 0) + entry.item.size;
      }
    }
    return map;
  }, [allEntries]);

  const qqGroupsMap = useMemo(() => {
    const map = new Map<string, typeof softwareGroups[number]>();
    for (const entry of allEntries) {
      const meta = inferJunkSoftware(entry.item);
      if (!meta.key.startsWith("qq")) continue;
      const cur = map.get(meta.key);
      if (!cur) {
        map.set(meta.key, { key: meta.key, label: meta.label, icon: meta.icon, tone: meta.tone, size: entry.item.size, count: entry.item.count ?? 0, safeLevel: entry.item.safeLevel, keys: [entry.key], items: [{ key: entry.key, item: entry.item }], detectPath: entry.item.detectPath, categorySizes: { [entry.item.category]: entry.item.size } });
      } else {
        cur.size += entry.item.size; cur.count += entry.item.count ?? 0; cur.safeLevel = mergeSafeLevel(cur.safeLevel, entry.item.safeLevel); cur.keys.push(entry.key); cur.items.push({ key: entry.key, item: entry.item }); cur.categorySizes[entry.item.category] = (cur.categorySizes[entry.item.category] ?? 0) + entry.item.size;
      }
    }
    return map;
  }, [allEntries]);

  // Windows section: always show all 18 fixed items regardless of size/filter
  const windowsGroupsMap = useMemo(() => {
    const map = new Map<string, typeof softwareGroups[number]>();
    for (const entry of allEntries) {
      const meta = inferJunkSoftware(entry.item);
      if (!meta.key.startsWith("windows-")) continue;
      const current = map.get(meta.key);
      if (!current) {
        map.set(meta.key, {
          key: meta.key, label: meta.label, icon: meta.icon, tone: meta.tone,
          size: entry.item.size, count: entry.item.count ?? 0,
          safeLevel: entry.item.safeLevel, keys: [entry.key],
          items: [{ key: entry.key, item: entry.item }],
          detectPath: entry.item.detectPath,
          categorySizes: { [entry.item.category]: entry.item.size }
        });
      } else {
        current.size += entry.item.size;
        current.count += entry.item.count ?? 0;
        current.safeLevel = mergeSafeLevel(current.safeLevel, entry.item.safeLevel);
        current.keys.push(entry.key);
        current.items.push({ key: entry.key, item: entry.item });
        if (!current.detectPath && entry.item.detectPath) current.detectPath = entry.item.detectPath;
        current.categorySizes[entry.item.category] = (current.categorySizes[entry.item.category] ?? 0) + entry.item.size;
      }
    }
    return map;
  }, [allEntries]);

  useEffect(() => {
    window.cDriveCleaner?.invoke("junk:preload-registry").catch(() => {});
  }, []);

  const [swIconCache, setSwIconCache] = useState<Record<string, string>>({});
  useEffect(() => {
    const api = window.cDriveCleaner;
    if (!api || softwareGroups.length === 0) return;
    const pending = softwareGroups.filter((g) => !(g.key in swIconCache));
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(
      pending.slice(0, 60).map(async (group) => {
        const firstItemPath = group.items[0]?.item.path;
        const url = await api.invoke<string | null>("junk:get-icon", {
          itemPath: firstItemPath,
          label: group.label,
          detectPath: group.detectPath
        });
        return { key: group.key, url: url ?? "" };
      })
    ).then((results) => {
      if (cancelled) return;
      const batch: Record<string, string> = {};
      for (const { key, url } of results) batch[key] = url;
      setSwIconCache((prev) => ({ ...prev, ...batch }));
    });
    return () => { cancelled = true; };
  }, [softwareGroups]);

  const selectedSoftware = selectedSoftwareKey
    ? (softwareGroups.find((g) => g.key === selectedSoftwareKey)
      ?? windowsGroupsMap.get(selectedSoftwareKey)
      ?? wechatGroupsMap.get(selectedSoftwareKey)
      ?? qqGroupsMap.get(selectedSoftwareKey)
      ?? null)
    : null;
  const selectedSoftwareSelectedSize = selectedSoftware
    ? selectedSoftware.items.reduce((sum, { key, item }) => selectedItems[key] ? sum + item.size : sum, 0)
    : 0;

  const flattenedRows = useMemo(() => {
    const rows: Array<
      | { type: "group"; groupCategory: JunkCategory; count: number; size: number; safeLevel: SafeLevel; label: string; keys: string[] }
      | { type: "item"; key: string; item: JunkItem }
    > = [];
    for (const entry of filteredGroups) {
      rows.push({
        type: "group",
        groupCategory: entry.group.category,
        count: entry.count,
        size: entry.size,
        safeLevel: entry.group.safeLevel,
        label: categoryLabel(entry.group.category),
        keys: entry.entries.map((item) => item.key)
      });
      if (!expandedGroups.has(entry.group.category)) {
        continue;
      }
      for (const itemEntry of entry.entries) {
        rows.push({
          type: "item",
          key: itemEntry.key,
          item: itemEntry.item
        });
      }
    }
    return rows;
  }, [expandedGroups, filteredGroups]);

  const ROW_HEIGHT = 40;
  const VIEWPORT_HEIGHT = 460;
  const startIndex = Math.max(0, Math.floor(junkScrollTop / ROW_HEIGHT) - 8);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 18;
  const endIndex = Math.min(flattenedRows.length, startIndex + visibleCount);
  const visibleRows = flattenedRows.slice(startIndex, endIndex);

  const toggleGroupExpanded = (category: JunkCategory): void => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const setRowSelected = (key: string, selected: boolean): void => {
    setSelectedItems((current) => ({ ...current, [key]: selected }));
  };

  const setGroupSelected = (keys: string[], selected: boolean): void => {
    setSelectedItems((current) => ({
      ...current,
      ...Object.fromEntries(keys.map((key) => [key, selected]))
    }));
  };

  async function runCleanupPreview(): Promise<CleanupPlan | null> {
    const api = window.cDriveCleaner;
    if (!api) {
      return null;
    }
    const selectedPaths = [...new Set(selectedEntries.map((entry) => entry.item.path))];
    setIsPreviewing(true);
    try {
      const selectedItems = selectedEntries.map((e) => ({
        path: e.item.path,
        safeLevel: e.item.safeLevel,
        ruleName: e.item.ruleName,
        category: e.item.category
      }));
      const plan = await api.invoke<CleanupPlan>("cleanup:preview", {
        selectedPaths,
        selectedItems,
        includeDanger: true
      });
      setCleanupPlan(plan);
      return plan;
    } finally {
      setIsPreviewing(false);
    }
  }

  async function runCleanupExecute(): Promise<void> {
    const api = window.cDriveCleaner;
    if (!api) {
      return;
    }
    const hasDanger = selectedEntries.some((e) => e.item.safeLevel === "danger");
    if (hasDanger) {
      const dangerItems = selectedEntries.filter((e) => e.item.safeLevel === "danger");
      const names = dangerItems.map((e) => e.item.ruleName).slice(0, 5).join("、");
      const extra = dangerItems.length > 5 ? `等 ${dangerItems.length} 项` : "";
      if (!window.confirm(`⚠️ 高风险警告（第 1 次确认）\n\n你选中了高风险项目：${names}${extra}\n\n这些项目删除后可能无法恢复，部分操作需要重启系统才能生效。\n\n确认继续？`)) return;
      if (!window.confirm(`🚨 高风险警告（第 2 次确认）\n\n你即将删除 ${dangerItems.length} 个高风险项目，这是不可逆操作。\n\n如果你不确定这些文件的用途，请点取消。\n\n你确定要删除吗？`)) return;
      if (!window.confirm(`🔴 最后警告（第 3 次确认）\n\n点击确定后将立即开始删除高风险项目，过程无法中断。\n\n这是最后一次机会取消。确定继续？`)) return;
    }
    setCleanupReport(null);
    setCleanupProgress(null);
    setShowFailureDetails(false);
    setIsCleaning(true);
    try {
      const plan = await runCleanupPreview();
      if (!plan || plan.targets.length === 0) {
        setCleanupProgress(null);
        return;
      }

      const report = await api.invoke<CleanupReport>("cleanup:execute", { plan });
      setCleanupReport(report);
      setShowFailureDetails(false);
      setLockerProcesses([]);
      setLockRetryResult(null);
      if (report.lockedFiles && report.lockedFiles.length > 0) {
        const lockers = await window.cDriveCleaner?.invoke<Array<{ pid: number; name: string; restartable: boolean; paths: string[] }>>("cleanup:find-lockers", { paths: report.lockedFiles });
        setLockerProcesses(lockers ?? []);
      }
      setCleanupPlan((current) =>
        current
          ? { ...current, targets: current.targets.filter((target) => report.failures.every((failure) => failure.path !== target.path)) }
          : current
      );
      // Remove successfully cleaned items from the displayed groups
      if (report.deletedCount > 0) {
        setCleanedItemPaths((prev) => {
          const next = new Set(prev);
          for (const entry of selectedEntries) {
            const itemPath = entry.item.path;
            // Item is fully cleaned if none of its files appear in the failure list
            const hasFailure = report.failures.some((f) => f.path.startsWith(itemPath) || f.path === itemPath);
            if (!hasFailure) next.add(itemPath);
          }
          return next;
        });
      }
    } finally {
      setIsCleaning(false);
    }
  }

  function cleanupOperationLabel(value: string): string {
    if (value === "manual") {
      return "手动清理";
    }
    if (value === "one_click") {
      return "一键清理";
    }
    if (value === "category") {
      return "分类清理";
    }
    return value;
  }

  function toggleCleanupLogExpanded(id: number): void {
    setExpandedCleanupLogIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const metrics: Metric[] = [
    { label: "可安全清理", value: formatBytes(safe.size), note: `${safe.count.toLocaleString("zh-CN")} 项`, icon: Check, tone: "green" },
    { label: "谨慎清理", value: formatBytes(caution.size), note: `${caution.count.toLocaleString("zh-CN")} 项`, icon: AlertTriangle, tone: "orange" },
    { label: "高风险项目", value: formatBytes(danger.size), note: `${danger.count.toLocaleString("zh-CN")} 项`, icon: ShieldCheck, tone: "red" },
    { label: "预计释放空间", value: formatBytes(selectedSize), note: `${selectedCount.toLocaleString("zh-CN")} 项`, icon: HardDrive, tone: "blue" }
  ];
  const activeScanOptions = junkOptionsFromPreset(scanPreset);
  const formatScanLimit = (value: number, suffix = ""): string => {
    if (!Number.isFinite(value) || value <= 0) {
      return "不限";
    }
    return `${Math.round(value)}${suffix}`;
  };
  const scanPresetLabel: Record<JunkScanPreset, string> = {
    fast: "快速",
    balanced: "均衡",
    deep: "深度",
    full: "全量"
  };

  return (
    <div className="page">
      <PageHead
        title="垃圾识别与一键清理"
        subtitle="智能识别无用文件，安全清理释放磁盘空间"
        right={(
          <button
            className="primary-btn"
            onClick={() => onStartScan(activeScanOptions)}
            disabled={scanState === "scanning"}
          >
            <Eraser size={18} style={scanState === "scanning" ? { animation: "spin 1s linear infinite" } : undefined} />
            {scanState === "scanning" ? "识别中..." : "开始识别"}
          </button>
        )}
      />
      {scanError && <div className="notice warning">{scanError}</div>}
      <MetricGrid metrics={metrics} columns={4} />

      <div className="grid layout-overview">
        <section className="card">
          <div className="card-title junk-toolbar">
            <div className="chips">
              <button className={`chip ${viewMode === "software" ? "active" : ""}`} onClick={() => setViewMode("software")}>
                按软件看（推荐）
              </button>
              <button className={`chip ${viewMode === "category" ? "active" : ""}`} onClick={() => setViewMode("category")}>
                按规则分类
              </button>
            </div>
            <div className="chips">
              {([
                { key: "all",     label: "全部项目",   count: allCount,      level: null },
                { key: "safe",    label: "可安全清理", count: safe.count,    level: "safe" as const },
                { key: "caution", label: "谨慎清理",   count: caution.count, level: "caution" as const },
                { key: "danger",  label: "高风险项目", count: danger.count,  level: "danger" as const },
              ] as const).map(({ key, label, count, level }) => (
                <span key={key} className={`chip level-chip ${activeLevelFilter === key ? "active" : ""}`}>
                  <button className="level-chip__label" onClick={() => setActiveLevelFilter(key)}>
                    {label}（{count.toLocaleString("zh-CN")}）
                  </button>
                  <span className="level-chip__divider" />
                  <button
                    className="level-chip__action"
                    title={level ? `全选${label}` : "全选所有"}
                    onClick={() => setSelectedItems((prev) => ({
                      ...prev,
                      ...Object.fromEntries(allEntries.filter((e) => !level || e.item.safeLevel === level).map((e) => [e.key, true]))
                    }))}
                  >✓</button>
                  <button
                    className="level-chip__action"
                    title={level ? `不选${label}` : "全不选"}
                    onClick={() => setSelectedItems((prev) => ({
                      ...prev,
                      ...Object.fromEntries(allEntries.filter((e) => !level || e.item.safeLevel === level).map((e) => [e.key, false]))
                    }))}
                  >✕</button>
                </span>
              ))}
            </div>
            <div className="chips">
              <span className="chip-label">最小显示</span>
              {MIN_SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`chip ${minSizeFilter === opt.value ? "active" : ""}`}
                  onClick={() => { setMinSizeFilter(opt.value); setCustomSizeInput(""); }}
                >
                  {opt.label}
                </button>
              ))}
              <input
                type="text"
                className={`chip chip-input${isCustomSize ? " active" : ""}`}
                placeholder="自定义 如 50MB"
                value={customSizeInput}
                onChange={(e) => setCustomSizeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyCustomSize(); }}
                onBlur={applyCustomSize}
              />
            </div>
            <button className="secondary-btn tiny-btn" onClick={() => setShowScanSettings(true)}>
              <Settings size={14} /> 扫描设置
            </button>
          </div>

          <div className="junk-list">
            {scanState === "idle" && (
              <div className="notice">尚未开始垃圾识别，请点击右上角『开始识别』。</div>
            )}
            {scanState === "scanning" && <JunkScanningOverlay />}
            {viewMode === "software" ? (
              <div className="sw-icon-sections">
                {WPS_SECTIONS.map((section) => {
                  // WeChat/QQ/Windows区：固定子项列表，与WPS完全对齐
                  const fixedItems =
                    section.key === "wechat_cleanup" ? WPS_WECHAT_FIXED_ITEMS :
                    section.key === "qq_cleanup" ? WPS_QQ_FIXED_ITEMS :
                    section.key === "windows_cleanup" ? WPS_WINDOWS_FIXED_ITEMS : null;
                  const fixedMap =
                    section.key === "wechat_cleanup" ? wechatGroupsMap :
                    section.key === "qq_cleanup" ? qqGroupsMap :
                    section.key === "windows_cleanup" ? windowsGroupsMap : null;

                  if (fixedItems && fixedMap) {
                    if (scanState !== "complete") return null;
                    return (
                      <Fragment key={section.key}>
                        <div className="sw-section-header">
                          <span className="sw-section-title">{section.title}</span>
                          <span className="sw-section-subtitle">{section.subtitle}</span>
                        </div>
                        <div className="sw-icon-grid">
                          {fixedItems.map(({ winKey, label, emoji, bg }) => {
                            const group = fixedMap.get(winKey);
                            const hasData = !!group && group.size > 0;
                            const allSel = hasData && group.keys.every((k) => selectedItems[k]);
                            const someSel = hasData && !allSel && group.keys.some((k) => selectedItems[k]);
                            return (
                              <div key={winKey} className={`sw-icon-btn${allSel ? " sw-icon-btn--selected" : ""}${!hasData ? " sw-icon-btn--empty" : ""}`} onClick={() => hasData ? setSelectedSoftwareKey(winKey) : undefined}>
                                <button className={`sw-icon-btn__check ${allSel ? "checked" : ""} ${someSel ? "partial" : ""}`} onClick={(e) => { e.stopPropagation(); if (group) setGroupSelected(group.keys, !allSel); }} title={allSel ? "取消选择" : "选择此项"} disabled={!hasData}>
                                  {allSel ? "✓" : someSel ? "−" : ""}
                                </button>
                                {group && <span className={`sw-icon-btn__level sw-icon-btn__level--${group.safeLevel}`} />}
                                <span className="sw-icon-btn__icon" style={{ background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px", lineHeight: 1 }}>
                                  {emoji}
                                </span>
                                <span className="sw-icon-btn__name">{label}</span>
                                <span className={`sw-icon-btn__size${!hasData ? " sw-icon-btn__size--zero" : ""}`}>{hasData ? formatBytes(group.size) : "0 KB"}</span>
                              </div>
                            );
                          })}
                        </div>
                      </Fragment>
                    );
                  }

                  // 其他区：动态分组
                  const sectionGroups = softwareGroups.filter((g) =>
                    classifyToWpsSection(g.key, g.categorySizes) === section.key
                  );
                  if (sectionGroups.length === 0) return null;
                  return (
                    <Fragment key={section.key}>
                      <div className="sw-section-header">
                        <span className="sw-section-title">{section.title}</span>
                        <span className="sw-section-subtitle">{section.subtitle}</span>
                      </div>
                      <div className="sw-icon-grid">
                        {sectionGroups.map((group) => {
                          const allSel = group.keys.length > 0 && group.keys.every((k) => selectedItems[k]);
                          const someSel = !allSel && group.keys.some((k) => selectedItems[k]);
                          const Icon = group.icon;
                          return (
                            <div
                              key={group.key}
                              className={`sw-icon-btn ${allSel ? "sw-icon-btn--selected" : ""}`}
                              onClick={() => setSelectedSoftwareKey(group.key)}
                            >
                              <button
                                className={`sw-icon-btn__check ${allSel ? "checked" : ""} ${someSel ? "partial" : ""}`}
                                onClick={(e) => { e.stopPropagation(); setGroupSelected(group.keys, !allSel); }}
                                title={allSel ? "取消选择" : "选择此软件"}
                              >
                                {allSel ? "✓" : someSel ? "−" : ""}
                              </button>
                              <span
                                className={`sw-icon-btn__level sw-icon-btn__level--${group.safeLevel}`}
                                title={group.safeLevel === "safe" ? "可安全清理" : group.safeLevel === "caution" ? "建议谨慎" : "高风险"}
                              />
                              {(() => {
                                const cached = swIconCache[group.key];
                                const fb = !cached ? getEmojiFallback(group.key, group.label) : null;
                                return (
                                  <span
                                    className={`sw-icon-btn__icon${!cached && !fb ? ` ${group.tone}-bg` : ""}`}
                                    style={fb ? { background: fb.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px", lineHeight: 1 } : undefined}
                                  >
                                    {cached
                                      ? <img src={cached} alt="" className="sw-icon-btn__img" />
                                      : fb
                                        ? fb.emoji
                                        : <span className={`sw-icon-btn__char ${group.tone}-bg`}>{group.label.slice(0, 2)}</span>}
                                  </span>
                                );
                              })()}
                              <span className="sw-icon-btn__name">{group.label}</span>
                              <span className={`sw-icon-btn__size${group.size === 0 ? " sw-icon-btn__size--zero" : ""}`}>{formatBytes(group.size)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </Fragment>
                  );
                })}
                {softwareGroups.length === 0 && scanState === "complete" && groups.length > 0 && (
                  <div className="notice">
                    {minSizeFilter > 0
                      ? `当前过滤条件下无结果。切换「最小显示」为「全部」可查看所有项目。`
                      : `当前规则没有命中可清理项。`}
                  </div>
                )}
                {hiddenSoftwareCount > 0 && (
                  <div className="size-filter-hint">
                    另有 {hiddenSoftwareCount} 个应用缓存因体积过小被隐藏
                    <button className="link-btn" onClick={() => setMinSizeFilter(0)}>显示全部</button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="junk-viewport" onScroll={(event) => setJunkScrollTop(event.currentTarget.scrollTop)}>
                  <div className="junk-virtual-pad" style={{ height: `${flattenedRows.length * ROW_HEIGHT}px` }}>
                    <div style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
                      {visibleRows.map((row) => {
                        if (row.type === "group") {
                          const selectedInGroup = row.keys.filter((key) => selectedItems[key]).length;
                          const allSelectedInGroup = row.keys.length > 0 && selectedInGroup === row.keys.length;
                          const someSelectedInGroup = selectedInGroup > 0 && selectedInGroup < row.keys.length;
                          const expanded = expandedGroups.has(row.groupCategory);
                          return (
                            <div key={`group-${row.groupCategory}`} className={`junk-row group ${expanded ? "expanded" : ""}`}>
                              <button className={`check-toggle ${allSelectedInGroup ? "checked" : ""} ${someSelectedInGroup ? "partial" : ""}`} onClick={() => setGroupSelected(row.keys, !allSelectedInGroup)}>
                                {allSelectedInGroup ? "✓" : someSelectedInGroup ? "−" : ""}
                              </button>
                              <Folder size={18} />
                              <button className="junk-toggle" onClick={() => toggleGroupExpanded(row.groupCategory)}>
                                <div>
                                  {row.label}
                                  <span>{row.count.toLocaleString("zh-CN")} 项，可清理 {formatBytes(row.size)}</span>
                                </div>
                              </button>
                              <b>{formatBytes(row.size)}</b>
                              <Badge level={row.safeLevel} />
                              <span className="desc">分类汇总</span>
                              <button className={`chevron-btn ${expanded ? "expanded" : ""}`} onClick={() => toggleGroupExpanded(row.groupCategory)}>
                                <ChevronRight size={17} />
                              </button>
                            </div>
                          );
                        }

                        const checked = selectedItems[row.key] ?? false;
                        return (
                          <div className="junk-row" key={row.key}>
                            <button className={`check-toggle ${checked ? "checked" : ""}`} onClick={() => setRowSelected(row.key, !checked)}>
                              {checked ? "✓" : ""}
                            </button>
                            <Folder size={18} />
                            <div className="path">{row.item.path}</div>
                            <b>{formatBytes(row.item.size)}</b>
                            <Badge level={row.item.safeLevel} />
                            <div className="desc">{row.item.description}</div>
                            <span />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                {flattenedRows.length === 0 && <div className="notice">正在等待真实规则扫描结果，或当前规则没有命中可清理项。</div>}
              </>
            )}
          </div>

          <div className="notice">高风险项目默认不选中，已被占用的文件将在清理时自动跳过。</div>

          <section className="subsection">
            <div className="card-title">
              <span>近期清理日志</span>
              <button className="link-btn" onClick={() => setShowAllCleanupLogs((current) => !current)}>
                {showAllCleanupLogs ? "收起" : "更多日志"} <ChevronRight size={15} />
              </button>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作</th>
                  <th>删除文件数</th>
                  <th>释放空间</th>
                  <th>失败项</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {cleanupLogs.map((log) => {
                  const expanded = expandedCleanupLogIds.has(log.id);
                  return (
                    <Fragment key={`log-${log.id}`}>
                      <tr>
                        <td>{formatActivityTime(log.executedAt)}</td>
                        <td>{cleanupOperationLabel(log.operationType)}</td>
                        <td>{log.filesDeleted.toLocaleString("zh-CN")} 项</td>
                        <td>{formatBytes(log.bytesFreed)}</td>
                        <td>{log.filesFailed.toLocaleString("zh-CN")} 项</td>
                        <td>
                          <button className="link-btn" onClick={() => toggleCleanupLogExpanded(log.id)}>
                            {expanded ? "收起" : "查看"}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6}>
                            <pre className="log-details">{JSON.stringify(log.details ?? {}, null, 2)}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>
        </section>

        <aside className="right-list preview-panel">
          <section className="card">
            <div className="card-title">清理预览</div>
            <span className="muted">已选项目</span>
            <div className="big">{formatBytes(selectedSize)}</div>
            <span className="muted">{selectedCount.toLocaleString("zh-CN")} 项</span>
            <div className="mini-donut" />
            <div className="legend">
              <span><i className="legend-dot green" /> 安全：{formatBytes(safe.size)}</span>
              <span><i className="legend-dot orange" /> 谨慎：{formatBytes(caution.size)}</span>
              <span><i className="legend-dot red" /> 高风险：{formatBytes(danger.size)}</span>
            </div>
            {cleanupProgress && (
              <div className="progress-block">
                <div className="split-note">
                  <span>
                    已处理 {cleanupProgress.processed} / {cleanupProgress.total}，成功 {cleanupProgress.deleted}，失败 {cleanupProgress.failed}
                  </span>
                  <b>{cleanupProgress.percent}%</b>
                </div>
                <Progress value={cleanupProgress.percent} />
              </div>
            )}
            {cleanupReport && (
              <div className="notice info">
                清理完成：删除 {cleanupReport.deletedCount} 项，释放 {formatBytes(cleanupReport.bytesFreed)}，失败 {cleanupReport.failedCount} 项。
                {cleanupReport.failedCount > 0 && (
                  <button className="link-btn" onClick={() => setShowFailureDetails((current) => !current)}>
                    {showFailureDetails ? "收起失败详情" : "查看失败详情"}
                  </button>
                )}
                {showFailureDetails && cleanupReport.failures.length > 0 && (
                  <div className="failure-list">
                    {cleanupReport.failures.slice(0, 20).map((failure) => (
                      <div key={failure.path} className="failure-item">
                        <b>{failure.reason}</b>
                        <span>{failure.path}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {lockerProcesses.length > 0 && !lockRetryResult && (
              <div className="notice warn">
                <b>以下程序正占用 {(cleanupReport?.lockedFiles ?? []).length} 个文件，阻止删除：</b>
                <ul style={{ margin: "6px 0 8px 16px", padding: 0 }}>
                  {lockerProcesses.map((lp) => (
                    <li key={lp.pid}>{lp.name}（PID {lp.pid}）{lp.restartable ? "· 可自动重启" : ""}</li>
                  ))}
                </ul>
                <button
                  className="primary-btn small"
                  disabled={isResolvingLocks}
                  onClick={async () => {
                    setIsResolvingLocks(true);
                    try {
                      const res = await window.cDriveCleaner?.invoke<{ deleted: string[]; failed: string[] }>("cleanup:close-and-retry", { paths: cleanupReport?.lockedFiles ?? [] });
                      setLockRetryResult({ deleted: res?.deleted.length ?? 0, failed: res?.failed.length ?? 0 });
                      setLockerProcesses([]);
                    } finally {
                      setIsResolvingLocks(false);
                    }
                  }}
                >
                  {isResolvingLocks ? "正在关闭并重试..." : "关闭占用程序并重试删除"}
                </button>
              </div>
            )}
            {lockRetryResult && (
              <div className="notice info">
                重试结果：成功删除 {lockRetryResult.deleted} 项，仍失败 {lockRetryResult.failed} 项。
              </div>
            )}
            <button
              className="primary-btn full"
              onClick={() => void runCleanupPreview()}
              disabled={scanState !== "complete" || selectedEntries.length === 0}
            >
              <FileSearch size={18} />
              {isPreviewing ? "正在生成预览..." : "预览清理"}
            </button>
            <button
              className="primary-btn full green-action"
              onClick={() => void runCleanupExecute()}
              disabled={scanState !== "complete" || selectedEntries.length === 0 || isCleaning}
            >
              <Trash2 size={18} />
              {isCleaning ? "正在清理..." : "确认清理"}
            </button>
          </section>
          <section className="card">
            <div className="card-title">将要删除（预览）</div>
            <DataTable
              headers={["路径", "大小"]}
              rows={(cleanupPlan?.targets ?? [])
                .slice(0, 6)
                .map((entry) => [entry.path, formatBytes(entry.size)])}
            />
          </section>
        </aside>
      </div>

      {selectedSoftware && (
        <div className="sw-detail-overlay" onClick={() => setSelectedSoftwareKey(null)}>
          <div className="sw-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sw-detail-modal__header">
              <span className={`sw-detail-modal__icon ${selectedSoftware.tone}-bg`}>
                <selectedSoftware.icon size={24} />
              </span>
              <div className="sw-detail-modal__info">
                <div className="sw-detail-modal__title">{selectedSoftware.label}</div>
                <div className="sw-detail-modal__subtitle">
                  共 {formatBytes(selectedSoftware.size)}，已选 {formatBytes(selectedSoftwareSelectedSize)}
                </div>
              </div>
              <button className="secondary-btn tiny-btn" onClick={() => setGroupSelected(selectedSoftware.keys, false)}>取消全部</button>
              <button className="primary-btn tiny-btn" onClick={() => { setGroupSelected(selectedSoftware.keys, true); setSelectedSoftwareKey(null); }}>确定</button>
              <button className="sw-detail-modal__close" onClick={() => setSelectedSoftwareKey(null)}>×</button>
            </div>
            <div className="sw-detail-modal__items">
              {(() => {
                const isDownloads = selectedSoftware.items.every(({ item }) => item.category === "downloads");
                const catMap = new Map<string, { keys: string[]; items: Array<{ key: string; item: JunkItem }>; size: number }>();
                for (const { key, item } of selectedSoftware.items) {
                  const cat = isDownloads ? item.ruleName : item.category;
                  const existing = catMap.get(cat);
                  if (!existing) {
                    catMap.set(cat, { keys: [key], items: [{ key, item }], size: item.size });
                  } else {
                    existing.keys.push(key);
                    existing.items.push({ key, item });
                    existing.size += item.size;
                  }
                }
                return [...catMap.entries()].map(([cat, group]) => {
                  const catKey = `cat::${cat}`;
                  const catExpanded = expandedItemKey === catKey;
                  const allChecked = group.keys.every((k) => selectedItems[k]);
                  const someChecked = !allChecked && group.keys.some((k) => selectedItems[k]);
                  return (
                    <Fragment key={cat}>
                      <div
                        className={`sw-detail-item ${allChecked ? "sw-detail-item--selected" : ""}`}
                        onClick={() => setExpandedItemKey(catExpanded ? null : catKey)}
                      >
                        <button
                          className={`check-toggle tiny ${allChecked ? "checked" : ""} ${someChecked ? "partial" : ""}`}
                          onClick={(e) => { e.stopPropagation(); setGroupSelected(group.keys, !allChecked); }}
                        >
                          {allChecked ? "✓" : someChecked ? "−" : ""}
                        </button>
                        <Folder size={18} color="#f59e0b" />
                        <span className="sw-detail-item__name">{isDownloads ? cat : categoryLabel(cat as JunkCategory)}</span>
                        <span className="sw-detail-item__size">{formatBytes(group.size)}</span>
                        <ChevronRight size={14} className="sw-detail-item__chevron" style={{ transform: catExpanded ? "rotate(90deg)" : undefined, transition: "transform 0.15s" }} />
                      </div>
                      {catExpanded && group.items.map(({ key, item }) => {
                        const checked = selectedItems[key] ?? false;
                        return (
                          <Fragment key={key}>
                            <div
                              className={`sw-detail-item sw-detail-item--sub ${checked ? "sw-detail-item--selected" : ""}`}
                              style={{ cursor: "pointer" }}
                              onClick={() => window.cDriveCleaner?.invoke("shell:show-in-folder", { path: item.path })}
                            >
                              <button className={`check-toggle tiny ${checked ? "checked" : ""}`} onClick={(e) => { e.stopPropagation(); setRowSelected(key, !checked); }}>
                                {checked ? "✓" : ""}
                              </button>
                              <Folder size={16} color="#fbbf24" />
                              <span className="sw-detail-item__name">
                                {isDownloads ? item.path.split("\\").pop() ?? item.path : item.ruleName}
                                <span className="sw-detail-item__path" title={item.path}>{isDownloads ? item.path : item.path}</span>
                              </span>
                              <span className="sw-detail-item__size">{formatBytes(item.size)}</span>
                              <button
                                className={`sw-detail-item__open ${expandedItemKey === key ? "active" : ""}`}
                                title="查看目录内容"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (expandedItemKey === key) { setExpandedItemKey(null); return; }
                                  setExpandedItemKey(key);
                                  setItemFileList([]);
                                  setItemFileListPartial(false);
                                  setItemFileListLoading(true);
                                  const res = await window.cDriveCleaner?.invoke<{ partial: boolean; entries: Array<{ name: string; size: number; type: "file" | "dir"; count?: number }> }>("junk:list-path", { path: item.path });
                                  setItemFileList(res?.entries ?? []);
                                  setItemFileListPartial(res?.partial ?? false);
                                  setItemFileListLoading(false);
                                }}
                              >
                                <ChevronRight size={13} style={{ transform: expandedItemKey === key ? "rotate(90deg)" : undefined, transition: "transform 0.15s" }} />
                              </button>
                            </div>
                            {expandedItemKey === key && (
                              <div className="sw-detail-item__files">
                                {itemFileListLoading && <span className="muted">加载中...</span>}
                                {!itemFileListLoading && itemFileList.length === 0 && <span className="muted">（空目录或无法访问）</span>}
                                {itemFileList.map((f) => (
                                  <div key={f.name} className="sw-detail-file">
                                    <span className="sw-detail-file__icon">{f.type === "dir" ? "📁" : "📄"}</span>
                                    <span className="sw-detail-file__name" title={f.name}>{f.name}</span>
                                    {f.count !== undefined && <span className="sw-detail-file__count muted">{f.count} 项</span>}
                                    <span className="sw-detail-file__size">{itemFileListPartial && f.type === "dir" ? "~" : ""}{formatBytes(f.size)}</span>
                                  </div>
                                ))}
                                {itemFileListPartial && <div className="sw-detail-file__note muted">⚠ 目录较大，子项大小为部分统计，实际大小以顶部为准</div>}
                              </div>
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}
      {showScanSettings && (
        <div className="modal-backdrop" onClick={() => setShowScanSettings(false)}>
          <div className="modal-card scan-settings-modal" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#1e293b" }}>扫描设置</span>
              <button style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#94a3b8", lineHeight: 1, padding: "2px 6px" }} onClick={() => setShowScanSettings(false)}>✕</button>
            </div>

            {/* Preset cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
              {([
                { key: "fast",     emoji: "⚡", title: "快速",  sub: "仅扫描高频垃圾",  color: "#f59e0b", bg: "#fffbeb", border: "#fde68a", opts: junkOptionsFromPreset("fast") },
                { key: "balanced", emoji: "⚖️", title: "均衡",  sub: "速度与全面性兼顾", color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe", opts: junkOptionsFromPreset("balanced") },
                { key: "deep",     emoji: "🔍", title: "深度",  sub: "更彻底，耗时较长", color: "#8b5cf6", bg: "#f5f3ff", border: "#ddd6fe", opts: junkOptionsFromPreset("deep") },
                { key: "full",     emoji: "🧩", title: "全量",  sub: "不设预算上限",   color: "#0f766e", bg: "#f0fdfa", border: "#99f6e4", opts: junkOptionsFromPreset("full") },
              ] as const).map(({ key, emoji, title, sub, color, bg, border, opts }) => {
                const active = scanPreset === key;
                return (
                  <button
                    key={key}
                    onClick={() => setScanPreset(key)}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                      padding: "14px 10px", borderRadius: 12, cursor: "pointer", textAlign: "center",
                      border: `2px solid ${active ? color : "#e2e8f0"}`,
                      background: active ? bg : "#f8fafc",
                      transition: "all 0.15s", outline: "none",
                    }}
                  >
                    <span style={{ fontSize: 28, lineHeight: 1 }}>{emoji}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: active ? color : "#334155" }}>
                      {title}{key === "balanced" && <span style={{ fontSize: 10, marginLeft: 4, background: color, color: "#fff", borderRadius: 4, padding: "1px 5px" }}>推荐</span>}
                    </span>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{sub}</span>
                    <span style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>超时 {formatScanLimit(opts.timeoutMs / 1000, "s")}</span>
                  </button>
                );
              })}
            </div>

            {/* Current config summary */}
            <div style={{ background: "#f1f5f9", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 20, marginBottom: 20, flexWrap: "wrap" }}>
              {[
                ["超时", formatScanLimit(activeScanOptions.timeoutMs / 1000, "s")],
                ["最大文件/规则", activeScanOptions.maxFilesPerTarget > 0 ? activeScanOptions.maxFilesPerTarget.toLocaleString("zh-CN") : "不限"],
                ["路径展开上限", activeScanOptions.maxMatchesPerPathPattern > 0 ? activeScanOptions.maxMatchesPerPathPattern.toLocaleString("zh-CN") : "不限"],
              ].map(([k, v]) => (
                <span key={k} style={{ fontSize: 12, color: "#475569" }}>{k}：<b style={{ color: "#1e293b" }}>{v}</b></span>
              ))}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="secondary-btn" onClick={() => setShowScanSettings(false)}>取消</button>
              <button className="secondary-btn" onClick={() => { setShowScanSettings(false); onOpenSettings(); }}>高级设置</button>
              <button
                className="primary-btn"
                onClick={() => { setShowScanSettings(false); onStartScan(junkOptionsFromPreset(scanPreset)); }}
                disabled={scanState === "scanning"}
              >
                <Eraser size={15} /> 立即识别
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
