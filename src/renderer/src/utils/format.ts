import type { ActivityLog, FileInfo, HealthScore, JunkCategory, SafeLevel } from "../../../shared/types";

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 KB";
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function percent(value: number): string {
  return `${Math.round(value)}%`;
}

export function compareWithPrevious(current: number, previous: number | null | undefined): string {
  if (!previous || previous <= 0) {
    return "较上次 -";
  }
  const delta = ((current - previous) / previous) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `较上次 ${sign}${delta.toFixed(1)}%`;
}

export function filterLargeFilesLocal(
  files: FileInfo[],
  type: FileInfo["type"] | "all",
  query: string
): FileInfo[] {
  const keyword = query.trim().toLowerCase();
  return files
    .filter((file) => (type === "all" ? true : file.type === type))
    .filter((file) => {
      if (!keyword) {
        return true;
      }
      if (keyword.startsWith(".")) {
        const ext = keyword.slice(1);
        return (file.name.toLowerCase().split(".").pop() ?? "") === ext;
      }
      return file.name.toLowerCase().includes(keyword);
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 50);
}

export function downloadFoldersCsv(rows: Array<{ name: string; path: string; size: number; ratio: string }>): void {
  const escapeCsv = (value: string): string => `"${value.replace(/"/g, "\"\"")}"`;
  const header = ["文件夹名", "路径", "大小(字节)", "占比"].join(",");
  const body = rows.map((folder) =>
    [escapeCsv(folder.name), escapeCsv(folder.path), String(folder.size), escapeCsv(folder.ratio)].join(",")
  );
  const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `top-folders-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function downloadLargeFilesCsv(rows: FileInfo[]): void {
  const escapeCsv = (value: string): string => `"${value.replace(/"/g, "\"\"")}"`;
  const header = ["文件名", "路径", "大小(字节)", "修改时间", "类型"].join(",");
  const body = rows.map((file) =>
    [
      escapeCsv(file.name),
      escapeCsv(file.path),
      String(file.size),
      escapeCsv(file.modifiedAt),
      escapeCsv(file.type)
    ].join(",")
  );
  const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `large-files-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function levelLabel(level: SafeLevel): string {
  return level === "safe" ? "安全" : level === "caution" ? "谨慎" : "高风险";
}

export function categoryLabel(category: JunkCategory): string {
  const labels: Record<JunkCategory, string> = {
    system_cache: "系统缓存",
    browser: "浏览器缓存",
    app_cache: "应用缓存",
    dev_cache: "开发者缓存",
    temp_files: "临时文件",
    recycle_bin: "回收站",
    logs: "日志文件",
    update_residual: "更新残留",
    downloads: "我的下载"
  };
  return labels[category];
}

export function fileTypeLabel(type: FileInfo["type"]): string {
  const labels: Record<FileInfo["type"], string> = {
    video: "视频",
    archive: "压缩包",
    installer: "安装包",
    log: "日志",
    image: "图片",
    document: "文档",
    other: "其他"
  };
  return labels[type];
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN");
}

export function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 60_000) {
    return "刚刚";
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)} 分钟前`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  }
  if (diffMs < 604_800_000) {
    return `${Math.floor(diffMs / 86_400_000)} 天前`;
  }
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function activityLabel(action: string): string {
  const labels: Record<string, string> = {
    scan_complete: "扫描完成",
    duplicate_scan_complete: "重复扫描完成",
    duplicate_cleanup_complete: "重复清理完成",
    cleanup_complete: "清理完成",
    migrate_complete: "迁移完成",
    migrate_rollback_complete: "迁移撤销完成",
    check_update: "检查更新",
    rules_updated: "规则更新"
  };
  return labels[action] ?? action;
}

export function activityDotClass(action: string): string {
  if (action.includes("scan")) {
    return "blue";
  }
  if (action.includes("cleanup") || action.includes("migrate")) {
    return "";
  }
  return "orange";
}

export function healthGradeLabel(grade: HealthScore["grade"]): string {
  if (grade === "excellent") {
    return "优秀";
  }
  if (grade === "good") {
    return "良好";
  }
  if (grade === "warning") {
    return "关注";
  }
  return "危险";
}

export function healthGradeClass(grade: HealthScore["grade"]): string {
  if (grade === "excellent" || grade === "good") {
    return "ok-text";
  }
  if (grade === "warning") {
    return "warn-text";
  }
  return "danger-text";
}

export function healthGradeColor(grade: HealthScore["grade"]): string {
  if (grade === "excellent" || grade === "good") {
    return "#10a66a";
  }
  if (grade === "warning") {
    return "#e89e1e";
  }
  return "#e04a4a";
}
