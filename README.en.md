<div align="center">

# C-Drive Cleaner Lite

**Windows system-drive toolkit**

Disk Scan · Junk Cleanup · Junction Migration · Duplicate Finder · Daily Monitor

[中文文档](README.md) · **English**

</div>

<br/>

## What is this

`C-Drive Cleaner Lite` is a Windows system-drive space management tool covering the full loop — **find it, free it, keep it clean**: scan the disk with the fastest available engine, precisely detect cleanable junk, relocate large directories losslessly to another drive, find and remove duplicate files, and track disk changes over time with daily monitoring.

Runs out of the box, no extra configuration needed.

## Features

### 🗂 Disk Scan & Large-File Analysis
- **Three-tier engine fallback**: Everything index (millisecond) → native C# MFT Reader that reads the NTFS Master File Table directly (millions of files in seconds) → `fs`-walk compatibility fallback
- **Interactive treemap**: visualizes directory size distribution with drill-down
- **Top 50 folders / Top 50 large files**: dual-pane view, filter by type
- **Safety**: automatically skips critical system directories; scan can pause / resume

### 🧹 Junk Detection & Cleanup
- **Dual rule engines**: curated built-in rules + WinApp2 community rule set
- **Smart categories**: system temp, browser cache, app cache, dev-tool cache, crash dumps, and more
- **Pre-clean preview**: expand to inspect matched files and estimated space; risky items highlighted for a second confirmation
- **Locked-file handling**: detects locking processes and supports close-and-retry

### 🔗 Junction Migration (Symlink)
- **Lossless relocation**: move large system-drive directories to another disk while a Junction keeps the original path fully working
- **6-step wizard**: select directory → target drive → confirm → migrate → backup → done
- **One-click rollback**: restore the original structure and remove the Junction
- **Health checks**: periodically verify migrated directories' Junction status

### 🗃 Duplicate File Finder
- Size pre-filter + exact SHA-256 comparison, batch select-and-delete

### 📊 Daily Monitor & Trends
- Scheduled snapshots, 7/30/90-day trend charts, abnormal-growth alerts, capacity forecast, system health score

---

## Interface Preview

| Overview | Disk Scan | Daily Monitor |
|:--------:|:---------:|:-------------:|
| ![Overview](docs/screenshots/overview.png) | ![Disk Scan](docs/screenshots/disk-scan.png) | ![Daily Monitor](docs/screenshots/daily-monitor.png) |

---

## Requirements

| Item | Requirement |
|:-----|:------------|
| **OS** | Windows 10 / 11 (x64) |
| **Runtime** | Electron bundled — no extra install |
| **MFT engine** (optional) | .NET 9 Runtime — greatly speeds up scanning |
| **Dev environment** | Node.js 18+, npm |

---

## Quick Start

```bash
# Install dependencies
npm install

# Start in dev mode
npm run dev
```

> On Windows you can also just double-click `start-dev.bat`.

### Building an installer

```bash
# Default build (no obfuscation / no hardening — easy to read & debug)
npm run build          # produces a Windows NSIS installer → release/

# Optional: hardened build (obfuscator + bytenode bytecode + Electron Fuses)
npm run build:harden
```

Build pipeline: publish the local MFT engine (`native/mft-reader`) → full build → (only when hardening) code hardening → electron-builder packaging.

> **Note**: the default build does **no code obfuscation** — `out/main/index.js` stays readable and debuggable. Only `npm run build:harden` enables obfuscation + bytecode + Fuses. `apply-fuses.cjs` auto-detects: Fuses are enabled only when the bytecode artifact (`.jsc`) exists.

---

## Tech Stack

| Layer | Tech |
|:------|:-----|
| **Frontend** | React 18 · TypeScript · Tailwind CSS · Lucide Icons |
| **Desktop** | Electron 33 |
| **Data** | better-sqlite3 |
| **Fast scan** | C# MFT Reader (.NET 9) |
| **Build** | electron-vite · electron-builder · javascript-obfuscator · bytenode |

---

<div align="center">

**MIT License**

</div>
