import type { JunkCategory, SafeLevel } from "../../shared/types";

export interface RawJunkRule {
  id?: string;
  name?: string;
  category?: string;
  paths?: string[];
  pattern?: string;
  detectPath?: string;
  safeLevel?: SafeLevel;
  safe_level?: SafeLevel;
  description?: string;
  builtin?: boolean;
  enabled?: boolean;
  source?: "builtin" | "custom" | "community";
  regKeys?: string[];
}

export interface JunkRule {
  id: string;
  name: string;
  category: JunkCategory;
  paths: string[];
  pattern?: string;
  detectPath?: string;
  safeLevel: SafeLevel;
  description: string;
  builtin: boolean;
  enabled: boolean;
  source: "builtin" | "custom" | "community";
  regKeys?: string[];
}

export interface JunkRuleFile {
  version?: string;
  updatedAt?: string;
  rules: RawJunkRule[];
}

export interface LoadedRuleSet {
  version?: string;
  updatedAt?: string;
  builtin: JunkRule[];
  custom: JunkRule[];
  merged: JunkRule[];
}

export interface RuleMatchOptions {
  maxMatchesPerPathPattern?: number;
  timeoutMs?: number;
}

