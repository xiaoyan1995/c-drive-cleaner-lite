import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Database,
  Download,
  FileArchive,
  HardDrive,
  Search,
  Trash2
} from "lucide-react";
import type { JunkItem, SafeLevel } from "../../../shared/types";
import type { Metric } from "../types";

export type JunkScanPreset = "fast" | "balanced" | "deep" | "full";

export interface JunkScanOptions {
  timeoutMs: number;
  maxFilesPerTarget: number;
  maxMatchesPerPathPattern: number;
}

export function junkOptionsFromPreset(preset: JunkScanPreset): JunkScanOptions {
  if (preset === "fast") {
    return {
      timeoutMs: 6000,
      maxFilesPerTarget: 20000,
      maxMatchesPerPathPattern: 800
    };
  }
  if (preset === "deep") {
    return {
      timeoutMs: 30000,
      maxFilesPerTarget: 200000,
      maxMatchesPerPathPattern: 5000
    };
  }
  if (preset === "full") {
    return {
      // `0` is interpreted by IPC as unlimited budget.
      timeoutMs: 0,
      maxFilesPerTarget: 0,
      maxMatchesPerPathPattern: 0
    };
  }
  // balanced
  return {
    timeoutMs: 20000,
    maxFilesPerTarget: 100000,
    maxMatchesPerPathPattern: 3000
  };
}

export const SOFTWARE_HINTS: Array<{ includes: string[]; key: string; label: string; icon: LucideIcon; tone: Metric["tone"] }> = [
  { includes: ["chrome"], key: "chrome", label: "Chrome", icon: Search, tone: "blue" },
  { includes: ["edge"], key: "edge", label: "Edge", icon: Search, tone: "blue" },
  { includes: ["firefox"], key: "firefox", label: "Firefox", icon: Search, tone: "blue" },
  { includes: ["brave"], key: "brave", label: "Brave", icon: Search, tone: "blue" },
  { includes: ["chromium"], key: "chromium", label: "Chromium", icon: Search, tone: "blue" },
  { includes: ["wxwork", "企业微信"], key: "wxwork", label: "企业微信", icon: AppWindow, tone: "green" },
  { includes: ["douyin", "抖音", "\\douyineffect\\", "\\dy_", "\\douyin\\"], key: "douyin", label: "抖音", icon: AppWindow, tone: "blue" },
  { includes: ["tiktok"], key: "tiktok", label: "TikTok", icon: AppWindow, tone: "blue" },
  { includes: ["kuaishou", "快手", "\\kwai\\"], key: "kuaishou", label: "快手", icon: AppWindow, tone: "orange" },
  { includes: ["windsurf"], key: "windsurf", label: "Windsurf", icon: AppWindow, tone: "purple" },
  { includes: ["cursor"], key: "cursor", label: "Cursor", icon: AppWindow, tone: "purple" },
  { includes: ["zhihu", "知乎"], key: "zhihu", label: "知乎", icon: AppWindow, tone: "blue" },
  { includes: ["weibo", "微博"], key: "weibo", label: "微博", icon: AppWindow, tone: "red" },
  { includes: ["xiaoyu", "小鱼", "\\yy\\", "\\huya\\", "虎牙"], key: "huya", label: "虎牙", icon: AppWindow, tone: "orange" },
  { includes: ["quark", "夸克"], key: "quark", label: "夸克网盘", icon: AppWindow, tone: "blue" },
  { includes: ["qqmusic", "qq音乐", "qqmusicdown", "tencentmusic"], key: "qqmusic", label: "QQ音乐", icon: AppWindow, tone: "green" },
  { includes: ["netease", "cloudmusic", "网易云音乐", "neteasemusic"], key: "netease-music", label: "网易云音乐", icon: AppWindow, tone: "red" },
  { includes: ["kugou"], key: "kugou", label: "酷狗音乐", icon: AppWindow, tone: "blue" },
  { includes: ["kuwo"], key: "kuwo", label: "酷我音乐", icon: AppWindow, tone: "orange" },
  { includes: ["youku", "优酷"], key: "youku", label: "优酷", icon: AppWindow, tone: "blue" },
  { includes: ["iqiyi", "爱奇艺", "qiyi"], key: "iqiyi", label: "爱奇艺", icon: AppWindow, tone: "green" },
  { includes: ["tencentvideo", "腾讯视频", "qqvideo"], key: "tencent-video", label: "腾讯视频", icon: AppWindow, tone: "blue" },
  { includes: ["mango", "芒果tv", "hunantv"], key: "mango", label: "芒果TV", icon: AppWindow, tone: "orange" },
  { includes: ["steam"], key: "steam", label: "Steam", icon: FileArchive, tone: "purple" },
  { includes: ["epic"], key: "epic", label: "Epic", icon: FileArchive, tone: "purple" },
  { includes: ["vscode", "\\code\\"], key: "vscode", label: "VS Code", icon: AppWindow, tone: "purple" },
  { includes: ["jetbrains"], key: "jetbrains", label: "JetBrains", icon: AppWindow, tone: "purple" },
  { includes: ["npm"], key: "npm", label: "npm", icon: FileArchive, tone: "orange" },
  { includes: ["pnpm"], key: "pnpm", label: "pnpm", icon: FileArchive, tone: "orange" },
  { includes: ["yarn"], key: "yarn", label: "Yarn", icon: FileArchive, tone: "orange" },
  { includes: ["pip"], key: "pip", label: "pip", icon: FileArchive, tone: "orange" },
  { includes: ["nuget"], key: "nuget", label: "NuGet", icon: FileArchive, tone: "orange" },
  { includes: ["gradle"], key: "gradle", label: "Gradle", icon: FileArchive, tone: "orange" },
  { includes: ["maven"], key: "maven", label: "Maven", icon: FileArchive, tone: "orange" },
  { includes: ["cargo"], key: "cargo", label: "Cargo", icon: FileArchive, tone: "orange" },
  { includes: ["onedrive"], key: "onedrive", label: "OneDrive", icon: AppWindow, tone: "blue" },
  { includes: ["nvidia"], key: "nvidia", label: "NVIDIA", icon: AppWindow, tone: "purple" },
  { includes: ["teams"], key: "teams", label: "Teams", icon: AppWindow, tone: "blue" },
  { includes: ["discord"], key: "discord", label: "Discord", icon: AppWindow, tone: "purple" },
  { includes: ["slack"], key: "slack", label: "Slack", icon: AppWindow, tone: "purple" },
  { includes: ["spotify"], key: "spotify", label: "Spotify", icon: AppWindow, tone: "green" },
  { includes: ["zoom"], key: "zoom", label: "Zoom", icon: AppWindow, tone: "blue" },
  { includes: ["telegram"], key: "telegram", label: "Telegram", icon: AppWindow, tone: "blue" },
  { includes: ["dingtalk", "钉钉"], key: "dingtalk", label: "钉钉", icon: AppWindow, tone: "blue" },
  { includes: ["wemeet", "腾讯会议", "tencent\\wemeet"], key: "wemeet", label: "腾讯会议", icon: AppWindow, tone: "green" },
  { includes: ["feishu", "lark", "飞书"], key: "feishu", label: "飞书", icon: AppWindow, tone: "blue" },
  { includes: ["wechat", "微信", "xwechat"], key: "wechat-cache", label: "微信 缓存文件", icon: AppWindow, tone: "green" },
  { includes: ["\\qq\\", "qqnt", "qqbrowser", "tim\\"], key: "qq-cache", label: "QQ 缓存文件", icon: AppWindow, tone: "green" },
  { includes: ["bilibili", "哔哩"], key: "bilibili", label: "哔哩哔哩", icon: AppWindow, tone: "blue" },
  { includes: ["baidunetdisk", "baiduyun", "百度网盘"], key: "baidupan", label: "百度网盘", icon: AppWindow, tone: "blue" },
  { includes: ["adobe"], key: "adobe", label: "Adobe", icon: AppWindow, tone: "red" },
  { includes: ["electronic arts", "ea desktop"], key: "ea", label: "EA App", icon: FileArchive, tone: "purple" }
];

export function prettifySoftwareLabel(raw: string): string {
  const cleaned = raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  if (/^[a-z0-9 .]+$/i.test(cleaned)) {
    return cleaned
      .split(" ")
      .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ");
  }
  return cleaned;
}

export function toSoftwareKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const EXCLUDED_DIR_NAMES = new Set([
  "microsoft", "windows", "temp", "cache", "caches", "logs", "log",
  "default", "profile", "profiles", "user data", "packages", "local",
  "roaming", "appdata", "programdata"
]);

export function extractSoftwareFromPath(path: string): string | null {
  const normalized = path.replace(/\//g, "\\");
  const directPatterns = [
    /\\AppData\\Local\\([^\\]+)/i,
    /\\AppData\\Roaming\\([^\\]+)/i,
    /\\ProgramData\\([^\\]+)/i,
    /\\Documents\\([^\\]+)/i
  ];
  for (const pattern of directPatterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    const lower = candidate.toLowerCase();
    if (EXCLUDED_DIR_NAMES.has(lower)) {
      const afterMatch = normalized.slice((match.index ?? 0) + match[0].length);
      const nextLevel = afterMatch.match(/^\\([^\\]+)/);
      const nextCandidate = nextLevel?.[1]?.trim();
      if (nextCandidate && !EXCLUDED_DIR_NAMES.has(nextCandidate.toLowerCase())) {
        return prettifySoftwareLabel(nextCandidate);
      }
      continue;
    }
    return prettifySoftwareLabel(candidate);
  }

  const userDataMatch = normalized.match(/\\([^\\]+)\\User Data\\[^\\]+\\(?:Cache|Code Cache|GPUCache)/i);
  if (userDataMatch?.[1]) {
    return prettifySoftwareLabel(userDataMatch[1]);
  }

  const cacheParent = normalized.match(/\\([^\\]+)\\(?:Cache|Caches|Code Cache|GPUCache|blob_storage|databases|data|logs?|Temp)(?:\\|$)/i);
  if (cacheParent?.[1]) {
    const candidate = cacheParent[1].trim();
    const lower = candidate.toLowerCase();
    if (!EXCLUDED_DIR_NAMES.has(lower) && candidate.length > 1 && !/^[a-f0-9-]{16,}$/i.test(candidate)) {
      return prettifySoftwareLabel(candidate);
    }
  }

  return null;
}

const RULE_SUFFIX_RE = /[\s\-_]+(缓存|临时文件|临时数据|日志|残留|残余|安装包|下载缓存|更新缓存|数据库|媒体缓存|旧文件|Cache|Caches|Code Cache|GPUCache|GPU Cache|Shader Cache|Media Cache|Temp|Logs?|Data|Update|Installer|Backup|Old|Residual|Database|Blobs?|Thumbnail|Webcache|Webcam)$/i;

export function normalizeRuleName(name: string): string {
  let result = name.trim();
  for (let i = 0; i < 3; i++) {
    const prev = result;
    result = result.replace(RULE_SUFFIX_RE, "").trim();
    if (result === prev) break;
  }
  return result || name;
}

// WeChat sub-item map (checked before SOFTWARE_HINTS)
const WECHAT_RULE_NAME_MAP: Record<string, string> = {
  "微信 日志文件":  "wechat-logs",
  "微信 缓存文件":  "wechat-cache",
  "微信 聊天图片":  "wechat-images",
  "微信 聊天视频":  "wechat-videos",
  "微信 接收的文件": "wechat-files",
  "微信 微信备份":  "wechat-backup",
  "微信日志":       "wechat-logs",
  "微信":           "wechat-cache",
  "微信 FileStorage 缓存": "wechat-images",
};

// QQ sub-item map (checked before SOFTWARE_HINTS)
const QQ_RULE_NAME_MAP: Record<string, string> = {
  "QQ 日志文件":  "qq-logs",
  "QQ 缓存文件":  "qq-cache",
  "QQ 聊天图片":  "qq-images",
  "QQ 聊天视频":  "qq-videos",
  "QQ 聊天语音":  "qq-voice",
  "QQ 接收的文件": "qq-files",
  "QQ 日志":      "qq-logs",
  "QQ 缓存目录":  "qq-cache",
  "QQ":           "qq-cache",
  "飞书 日志文件": "feishu-logs",
  "飞书缓存":      "feishu-cache",
};

// Explicit whitelist: items from these rule names always go to Windows可清理 section
const WINDOWS_RULE_NAME_MAP: Record<string, string> = {
  "临时文件":     "windows-temp",
  "日志文件":     "windows-logs",
  "缓存文件":     "windows-cache",
  "缩略图缓存":   "windows-thumbnail",
  "升级补丁备份": "windows-patch",
  "系统更新缓存": "windows-update",
  "旧版系统文件": "windows-old",
  "系统诊断数据": "windows-diag",
  "系统安全中心": "windows-security",
  ".Net框架":     "windows-dotnet",
  "回收站":       "windows-recycle",
  "小型转储文件": "windows-minidump",
  "内存转储文件": "windows-memdump",
  "其它文件":     "windows-other",
  "软件临时安装包": "windows-installer",
  "系统还原点":   "windows-restore",
  "系统休眠文件": "windows-hibernate",
  "转移虚拟内存": "windows-pagefile",
};

export function inferJunkSoftware(item: JunkItem): { key: string; label: string; icon: LucideIcon; tone: Metric["tone"] } {
  if (item.category === "downloads") {
    return { key: "my-downloads", label: "我的下载", icon: Download, tone: "blue" };
  }

  // WeChat sub-items
  const wxKey = WECHAT_RULE_NAME_MAP[item.ruleName];
  if (wxKey) return { key: wxKey, label: item.ruleName, icon: AppWindow, tone: "green" };

  // QQ sub-items
  const qqKey = QQ_RULE_NAME_MAP[item.ruleName];
  if (qqKey) return { key: qqKey, label: item.ruleName, icon: AppWindow, tone: "green" };

  // Windows system items — use rule name directly, skip all path inference
  const winKey = WINDOWS_RULE_NAME_MAP[item.ruleName];
  if (winKey) {
    return { key: winKey, label: item.ruleName, icon: AppWindow, tone: "blue" };
  }

  const text = `${item.ruleName} ${item.path}`.toLowerCase();
  for (const hint of SOFTWARE_HINTS) {
    if (hint.includes.some((keyword) => text.includes(keyword))) {
      return { key: hint.key, label: hint.label, icon: hint.icon, tone: hint.tone };
    }
  }

  const softwareByPath = extractSoftwareFromPath(item.path);
  if (softwareByPath) {
    return {
      key: `app-${toSoftwareKey(softwareByPath) || "unknown"}`,
      label: softwareByPath,
      icon: AppWindow,
      tone: item.category === "browser" ? "blue" : item.category === "dev_cache" ? "orange" : "green"
    };
  }

  const normalizedName = normalizeRuleName(item.ruleName);
  const ruleKey = `rule-${toSoftwareKey(normalizedName) || "misc"}`;
  const toneByCategory: Record<string, Metric["tone"]> = {
    browser: "blue", app_cache: "green", dev_cache: "orange",
    recycle_bin: "red", logs: "orange", update_residual: "orange"
  };
  return {
    key: ruleKey,
    label: normalizedName,
    icon: item.category === "recycle_bin" ? Trash2 : item.category === "logs" ? Database : AppWindow,
    tone: toneByCategory[item.category] ?? "blue"
  };
}

export function mergeSafeLevel(current: SafeLevel, next: SafeLevel): SafeLevel {
  if (current === "danger" || next === "danger") return "danger";
  if (current === "caution" || next === "caution") return "caution";
  return "safe";
}
