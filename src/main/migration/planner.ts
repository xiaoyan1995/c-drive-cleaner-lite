import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DirTree, DriveInfo, RecommendedDir } from "../../shared/types";

const execFileAsync = promisify(execFile);

interface LogicalDiskRow {
  DeviceID?: string;
  VolumeName?: string;
  FileSystem?: string;
  Size?: number | string;
  FreeSpace?: number | string;
}

interface ScoredCandidate {
  path: string;
  size: number;
  fileCount: number;
  score: number;
  reason: string;
  dailyGrowth: number;
}

function parseNumber(value: number | string | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeDeviceId(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

// Top-level directories that must NEVER be migrated (case-insensitive)
const BLOCKED_TOPLEVEL = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "$recycle.bin",
  "system volume information",
  "recovery",
  "boot",
  "perflogs",
  "$windows.~bt",
  "$windows.~ws",
  "windows.old",
  "msocache",
]);

/**
 * Returns true if the path is too risky to recommend for migration.
 * - Blocks known Windows/system top-level dirs entirely
 * - Blocks C:\Users and C:\Users\<username> roots (allow deeper subdirs)
 * - Blocks C:\ProgramData root itself (allow subdirs)
 */
function isBlockedMigrationPath(pathParts: string[]): boolean {
  if (pathParts.length < 2) return true;
  const top = pathParts[1]?.toLowerCase() ?? "";
  if (BLOCKED_TOPLEVEL.has(top)) return true;
  // Block "C:\Users" and "C:\Users\<name>" but allow deeper paths
  if (top === "users" && pathParts.length <= 3) return true;
  // Block "C:\ProgramData" root itself (allow subdirs)
  if (top === "programdata" && pathParts.length <= 2) return true;
  // Block AppData root and its top-level buckets (Local/Roaming/LocalLow) — too broad
  // Allow only app-specific subdirs: C:\Users\<name>\AppData\Local\<app> (depth >= 6)
  const lower = pathParts.map((p) => p.toLowerCase());
  const appDataIdx = lower.indexOf("appdata");
  if (appDataIdx !== -1) {
    // pathParts.length <= appDataIdx + 2 means the path is AppData itself or AppData\Local etc.
    if (pathParts.length <= appDataIdx + 2) return true;
  }
  return false;
}

// Folder names that are definitely growing caches — highest priority
const CACHE_FOLDER_NAMES = new Set([
  "cache", "caches", "cacheddata", "gpucache", "code cache",
  "crashreports", "crashpad", "blob_storage",
  "temp", "tmp", "temporary", "temporaryfiles",
  "download", "downloads",
  "npm-cache", ".npm",
  ".gradle", ".m2", ".nuget", ".ivy2",
  ".cargo", ".rustup",
  "pip", "pipenv", "__pycache__",
  "node_modules",
  "logs", "log",
]);

// Known continuously-growing AppData subdirectory patterns
const GROWING_APPDATA_PATTERNS: RegExp[] = [
  /\\appdata\\local\\(microsoft\\(visualstudio|vscode|teams|edge|windowsapps|fontcache)|packages)/i,
  /\\appdata\\local\\(google|chromium|brave-browser|vivaldi|opera|yandex)/i,
  /\\appdata\\local\\(discord|slack|zoom|webex|lark|feishu|dingtalk|wechat|qq)/i,
  /\\appdata\\local\\(pip|poetry|pypoetry|conda|miniconda|anaconda)/i,
  /\\appdata\\local\\(unity|unreal engine|epicgames|steam)/i,
  /\\appdata\\roaming\\(npm|composer|cargo|maven)/i,
  /\\programdata\\(docker|nvidia|amd|intel|microsoft)/i,
];

function scorePath(path: string): { score: number; reason: string } {
  const lower = path.toLowerCase();
  const leaf = lower.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const inAppData = /\\appdata\\(local|roaming|locallow)\\/i.test(lower);

  // Tier 1: cache-named folder inside AppData — auto-grows every time the app runs
  if (inAppData && CACHE_FOLDER_NAMES.has(leaf)) {
    return { score: 99, reason: "AppData 缓存目录，随软件使用自动增长，迁移后立竿见影" };
  }

  // Tier 2: cache-named folder elsewhere (ProgramData, user dirs…)
  if (CACHE_FOLDER_NAMES.has(leaf)) {
    return { score: 94, reason: "缓存/临时数据目录，随软件使用持续增长，迁移风险低" };
  }

  // Tier 3: known continuously-growing AppData software dirs
  if (GROWING_APPDATA_PATTERNS.some((re) => re.test(lower))) {
    return { score: 90, reason: "已知持续增长的 AppData 软件数据目录，迁移后仍可正常访问" };
  }

  // Tier 4: any AppData subfolder (app-managed, tends to grow)
  if (inAppData) {
    return { score: 83, reason: "AppData 应用数据目录，通常随软件使用持续增长，适合迁移到大容量磁盘" };
  }

  // Tier 5: ProgramData subfolder (lower priority — system-adjacent)
  if (/\\programdata\\/i.test(lower)) {
    return { score: 62, reason: "系统应用数据区子目录，体积可能随软件使用增长" };
  }

  // Tier 6: user document/media dirs (large but not cache, don't auto-grow)
  if (/\\users\\[^\\]+\\(documents|downloads|desktop|pictures|videos|music|onedrive|dropbox|icloud)/i.test(lower)) {
    return { score: 52, reason: "用户文档/媒体目录，体积较大时可手动评估是否迁移" };
  }
  if (/\\users\\/i.test(lower)) {
    return { score: 45, reason: "用户数据目录，建议优先迁移 AppData 缓存后再评估" };
  }

  return { score: 30, reason: "该目录体积较大，建议优先迁移 AppData 缓存" };
}

function flattenTree(root: DirTree): DirTree[] {
  const result: DirTree[] = [];
  const stack: DirTree[] = [...(root.children ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    result.push(current);
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return result;
}

export function buildMigrationRecommendations(tree: DirTree, limit = 20): RecommendedDir[] {
  return buildMigrationRecommendationsWithGrowth(tree, limit, new Map<string, number>());
}

/**
 * Returns all C: directories sorted purely by size (largest first) with only
 * absolute-system-path filtering — no score/growth requirement.
 * Used for the left "browse" list in the migration wizard (mirrors disk-scan top folders).
 */
export function buildMigrationBrowseList(tree: DirTree, limit = 200): RecommendedDir[] {
  const nodes = flattenTree(tree);
  const seen = new Map<string, RecommendedDir>();

  for (const node of nodes) {
    if (node.size < 100 * 1024 * 1024) continue;
    if ((node.children?.length ?? 0) === 0 && (node.fileCount ?? 0) === 0) continue;
    const normalizedPath = node.path.replace(/\//g, "\\");
    if (!normalizedPath.toLowerCase().startsWith("c:\\")) continue;
    const pathParts = splitPath(normalizedPath);
    if (isBlockedMigrationPath(pathParts)) continue;
    const key = normalizedPath.toLowerCase();
    const { score, reason } = scorePath(normalizedPath);
    const existing = seen.get(key);
    if (!existing || node.size > existing.size) {
      seen.set(key, {
        path: normalizedPath,
        size: node.size,
        fileCount: node.fileCount ?? 0,
        dailyGrowth: 0,
        score,
        reason
      });
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

export function buildMigrationRecommendationsWithGrowth(
  tree: DirTree,
  limit = 20,
  growthHints: ReadonlyMap<string, number>
): RecommendedDir[] {
  const nodes = flattenTree(tree);
  const candidates: ScoredCandidate[] = [];
  const requireGrowthRule = growthHints.size > 0;

  for (const node of nodes) {
    if (node.size < 512 * 1024 * 1024) {
      continue;
    }
    if ((node.children?.length ?? 0) === 0 && (node.fileCount ?? 0) === 0) {
      continue;
    }
    const normalizedPath = node.path.replace(/\//g, "\\");
    if (!normalizedPath.toLowerCase().startsWith("c:\\")) {
      continue;
    }
    const pathParts = splitPath(normalizedPath);
    if (isBlockedMigrationPath(pathParts)) {
      continue;
    }
    const { score, reason } = scorePath(normalizedPath);
    const topLevel = pathParts.length >= 2 ? pathParts[1].toLowerCase() : "";
    const leaf = pathParts[pathParts.length - 1]?.toLowerCase() ?? "";
    const dailyGrowth =
      growthHints.get(normalizedPath.toLowerCase()) ??
      growthHints.get(topLevel) ??
      growthHints.get(leaf) ??
      0;
    // Never recommend personal/document dirs regardless of size — not auto-growing cache
    if (score < 75) continue;
    // For mid-tier dirs (75-79, e.g. user media), require actual growth data
    if (requireGrowthRule && score < 80 && dailyGrowth < 50 * 1024 * 1024) {
      continue;
    }
    const sizeScore = Math.min(25, Math.round(node.size / (1024 ** 3)));
    candidates.push({
      path: normalizedPath,
      size: node.size,
      fileCount: node.fileCount ?? 0,
      score: score + sizeScore,
      reason,
      dailyGrowth
    });
  }

  // Deduplicate exact paths, keeping best score/size
  const unique = new Map<string, ScoredCandidate>();
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase();
    const existing = unique.get(key);
    if (!existing || candidate.score > existing.score || candidate.size > existing.size) {
      unique.set(key, candidate);
    }
  }

  // Bubble-up: if 2+ siblings share the same parent, replace them with the parent itself
  const byParent = new Map<string, ScoredCandidate[]>();
  for (const candidate of unique.values()) {
    const parentPath = candidate.path.replace(/[\\/][^\\/]+$/, "");
    if (!parentPath || parentPath.toLowerCase() === candidate.path.toLowerCase()) continue;
    const key = parentPath.toLowerCase();
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(candidate);
  }
  const absorbedPaths = new Set<string>();
  const bubbled: ScoredCandidate[] = [];
  for (const [parentKey, siblings] of byParent) {
    if (siblings.length < 2) continue;
    const parentPath = siblings[0].path.replace(/[\\/][^\\/]+$/, "");
    if (isBlockedMigrationPath(splitPath(parentPath))) continue;
    const totalSize = siblings.reduce((s, c) => s + c.size, 0);
    const totalFiles = siblings.reduce((s, c) => s + c.fileCount, 0);
    const maxScore = Math.max(...siblings.map((c) => c.score));
    const maxGrowth = Math.max(...siblings.map((c) => c.dailyGrowth));
    const sizeBonus = Math.min(25, Math.round(totalSize / 1024 ** 3));
    bubbled.push({
      path: parentPath,
      size: totalSize,
      fileCount: totalFiles,
      score: Math.min(120, maxScore + sizeBonus + 3),
      reason: `含 ${siblings.length} 个持续增长子目录，迁移整个目录效率更高`,
      dailyGrowth: maxGrowth
    });
    for (const sibling of siblings) absorbedPaths.add(sibling.path.toLowerCase());
    // Ensure parent key itself is removed if it was already a candidate
    absorbedPaths.add(parentKey);
  }

  const merged = [
    ...bubbled,
    ...[...unique.values()].filter((c) => !absorbedPaths.has(c.path.toLowerCase()))
  ];

  return merged
    .sort((left, right) => {
      // Primary: score — AppData cache dirs rank above generic large dirs
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      // Secondary: size — largest first within same score tier
      if (right.size !== left.size) {
        return right.size - left.size;
      }
      // Tertiary: daily growth
      return right.dailyGrowth - left.dailyGrowth;
    })
    .slice(0, Math.max(1, Math.min(limit, 200)))
    .map((candidate) => ({
      path: candidate.path,
      size: candidate.size,
      fileCount: candidate.fileCount,
      dailyGrowth: candidate.dailyGrowth,
      score: candidate.score,
      reason:
        candidate.dailyGrowth > 0
          ? `近 3 天平均日增长 ${Math.round(candidate.dailyGrowth / 1024 / 1024)} MB，${candidate.reason}`
          : candidate.reason
    }));
}

/** Single PowerShell call to get all drive letters → MediaType mapping. */
let _driveTypeCache: { data: Record<string, "ssd" | "hdd" | "unknown">; ts: number } | null = null;
let _driveTypePending: Promise<Record<string, "ssd" | "hdd" | "unknown">> | null = null;

async function getAllDriveTypes(): Promise<Record<string, "ssd" | "hdd" | "unknown">> {
  if (process.platform !== "win32") return {};
  // Return cache if fresh (60s)
  if (_driveTypeCache && Date.now() - _driveTypeCache.ts < 60_000) return _driveTypeCache.data;
  // Deduplicate concurrent calls
  if (_driveTypePending) return _driveTypePending;
  _driveTypePending = _getAllDriveTypesImpl().finally(() => { _driveTypePending = null; });
  return _driveTypePending;
}

async function _getAllDriveTypesImpl(): Promise<Record<string, "ssd" | "hdd" | "unknown">> {
  try {
    // Strategy 1: Get-Partition + Get-PhysicalDisk (covers internal & NVMe drives)
    // Strategy 2: WMI chain Win32_LogicalDiskToPartition → Win32_DiskDrive (covers USB/external)
    // Both run together; Strategy 1 wins on conflict.
    const command = [
      "$r = @{};",
      // Strategy 2 first (lower priority)
      "try {",
      "  Get-CimInstance Win32_LogicalDiskToPartition -ErrorAction SilentlyContinue | ForEach-Object {",
      "    $lid = $_.Dependent.DeviceID -replace ':','';",
      "    $pidx = [regex]::Match($_.Antecedent.DeviceID,'Disk #(\\d+)').Groups[1].Value;",
      "    $dd = Get-CimInstance Win32_DiskDrive -Filter \"Index=$pidx\" -ErrorAction SilentlyContinue | Select-Object -First 1;",
      "    if ($dd) {",
      "      $mt = [string]$dd.MediaType;",
      "      if ($mt -match 'Fixed|External') { $r[$lid] = 'hdd' } elseif ($mt -match 'SSD|Solid') { $r[$lid] = 'ssd' } else { $r[$lid] = 'unknown' }",
      "    }",
      "  }",
      "} catch {}",
      // Strategy 1 (higher priority — overwrites)
      "try {",
      "  $parts = Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -and ([int][char]$_.DriveLetter) -gt 0 };",
      "  $pd = Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object DeviceId,MediaType;",
      "  foreach ($p in $parts) {",
      "    $dl = [string]$p.DriveLetter;",
      "    $disk = $pd | Where-Object { [string]$_.DeviceId -eq [string]$p.DiskNumber } | Select-Object -First 1;",
      "    if ($disk) {",
      "      $mt = [string]$disk.MediaType;",
      "      if ($mt -eq 'SSD') { $r[$dl] = 'ssd' } elseif ($mt -eq 'HDD') { $r[$dl] = 'hdd' } else { $r[$dl] = 'unknown' }",
      "    }",
      "  }",
      "} catch {}",
      "$r | ConvertTo-Json -Compress"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command
    ], { timeout: 12_000 });
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === "null") return {};
    const raw = JSON.parse(trimmed) as Record<string, string>;
    const result: Record<string, "ssd" | "hdd" | "unknown"> = {};
    for (const [letter, mt] of Object.entries(raw)) {
      const v = (mt ?? "").toLowerCase();
      result[letter.toUpperCase()] = v === "ssd" ? "ssd" : v === "hdd" ? "hdd" : "unknown";
    }
    _driveTypeCache = { data: result, ts: Date.now() };
    return result;
  } catch (e) {
    console.error("[getAllDriveTypes] failed:", e);
    // Return stale cache if available, rather than losing data
    if (_driveTypeCache) return _driveTypeCache.data;
    return {};
  }
}

export async function listMigrationDrives(excludeDrive = "C:"): Promise<DriveInfo[]> {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const command = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ",
      "$rows = Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | ",
      "Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace;",
      "$rows | ConvertTo-Json -Compress"
    ].join("");
    const [{ stdout }, typeMap] = await Promise.all([
      execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command
      ]),
      getAllDriveTypes()
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }
    const parsed = JSON.parse(trimmed) as LogicalDiskRow | LogicalDiskRow[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const blocked = normalizeDeviceId(excludeDrive);

    const drives = rows
      .map((row) => {
        const letter = normalizeDeviceId(row.DeviceID);
        return {
          letter,
          label: row.VolumeName && row.VolumeName.trim().length > 0 ? row.VolumeName.trim() : "本地磁盘",
          totalSize: parseNumber(row.Size),
          freeSize: parseNumber(row.FreeSpace),
          fsType: (row.FileSystem ?? "").toString().trim() || "Unknown",
          driveType: typeMap[letter.replace(":", "")] ?? "unknown"
        };
      })
      .filter((drive) => drive.letter.length > 0)
      .filter((drive) => drive.letter !== blocked)
      .sort((left, right) => left.letter.localeCompare(right.letter, "en-US"));
    return drives;
  } catch {
    return [];
  }
}

export function buildDefaultTargetPath(
  driveLetter: string,
  sourcePath: string,
  baseFolder = "CDrive_Moved_Data"
): string {
  const normalizedDrive = normalizeDeviceId(driveLetter).replace(/\\+$/, "");
  const cleanedSource = sourcePath.replace(/[\\/]+$/, "");
  const parts = splitPath(cleanedSource);
  const leafName = (parts[parts.length - 1] ?? "MovedFolder").replace(/[<>:"/\\|?*]+/g, "_");
  return `${normalizedDrive}\\${baseFolder}\\${leafName}`;
}
