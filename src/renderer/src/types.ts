import type { LucideIcon } from "lucide-react";
import type { JunkCategory, SafeLevel } from "../../shared/types";

export type PageId = "overview" | "scan" | "duplicate" | "junk" | "migrate" | "monitor" | "settings";
export type ScanState = "idle" | "scanning" | "paused" | "stopped" | "complete" | "error";
export type DuplicateState = "idle" | "scanning" | "complete" | "error";
export type JunkViewMode = "software" | "category";
export type OneClickTaskKey = "disk" | "junk" | "duplicate";
export type OneClickStage = "idle" | OneClickTaskKey | "done" | "error";

export interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
}

export interface Metric {
  label: string;
  value: string;
  note: string;
  icon: LucideIcon;
  tone: "blue" | "green" | "orange" | "red" | "purple";
  progress?: number;
}

export interface CustomRuleRow {
  id: string;
  name: string;
  category: JunkCategory;
  paths: string[];
  pattern?: string;
  safeLevel: SafeLevel;
  description: string;
  enabled: boolean;
}
