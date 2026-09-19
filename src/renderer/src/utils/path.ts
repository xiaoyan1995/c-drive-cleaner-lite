export function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

export function isSameOrNestedPath(candidate: string, target: string): boolean {
  const left = normalizePath(candidate);
  const right = normalizePath(target);
  return left === right || left.startsWith(`${right}\\`);
}

export function normalizeWindowsPath(input: string): string {
  return input.trim().replace(/\//g, "\\").replace(/[\\]+$/, "");
}

export function normalizeScanRootPath(input: string): string {
  const normalized = input.trim().replace(/\//g, "\\");
  const match = normalized.match(/^([a-z]):/i);
  if (match) {
    return `${match[1].toUpperCase()}:\\`;
  }
  const singleLetter = normalized.match(/^([a-z])$/i);
  if (singleLetter) {
    return `${singleLetter[1].toUpperCase()}:\\`;
  }
  return "C:\\";
}

export function driveRootFromLetter(letter: string): string {
  return normalizeScanRootPath(letter);
}

export function isValidMigrationSourcePath(input: string, systemDrive = "C:"): boolean {
  const normalized = normalizeWindowsPath(input);
  const drive = normalizeScanRootPath(systemDrive).slice(0, 2).toLowerCase();
  return normalized.toLowerCase().startsWith(`${drive}\\`) && normalized.length > 3;
}

export function getPathLeaf(path: string): string {
  const normalized = normalizeWindowsPath(path);
  const parts = normalized.split("\\").filter((segment) => segment.length > 0);
  return parts[parts.length - 1] ?? "MovedFolder";
}

export function buildTargetPathFromSource(driveLetter: string, sourcePath: string): string {
  const drive = driveLetter.trim().replace(/\\+$/, "").toUpperCase();
  const leaf = getPathLeaf(sourcePath).replace(/[<>:"/\\|?*]+/g, "_");
  return `${drive}\\CDrive_Moved_Data\\${leaf}`;
}
