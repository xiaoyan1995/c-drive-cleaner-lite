<div align="center">

# C-Drive Cleaner Lite

**Windows 系统盘工具箱**

磁盘扫描 · 垃圾清理 · 软链接迁移 · 重复文件检测 · 每日监控

**中文** · [English](README.en.md)

</div>

<br/>

## 这是什么

`C-Drive Cleaner Lite` 是一款面向 Windows 的系统盘空间管理工具，聚焦「发现问题 → 释放空间 → 保持整洁」这条完整链路：用最快的引擎扫描磁盘、精准识别可清理的垃圾、把大目录无损搬迁到其他盘、找出并清掉重复文件，再通过每日监控长期跟踪磁盘变化。

启动即用，无需额外配置。

## 功能

### 🗂 磁盘扫描与大文件分析
- **三级扫描引擎自动降级**：优先 Everything 索引（毫秒级），其次原生 C# MFT Reader 直读 NTFS 主文件表（秒级百万文件），最后回退 os.walk 兼容模式
- **可视化目录树**：交互式热力图（Treemap）展示目录大小分布，支持逐层下钻
- **文件夹 Top 50 / 大文件 Top 50**：双栏展示，支持按类型筛选，可导出列表
- **安全保护**：自动跳过系统关键目录，扫描可暂停 / 继续

### 🧹 垃圾识别与清理
- **双规则引擎**：内置精选规则 + WinApp2 社区规则库
- **智能分类**：系统临时文件、浏览器缓存、应用缓存、开发工具缓存、崩溃转储等
- **清理前预览**：展开查看命中文件与预计释放空间，危险项标红二次确认
- **占用文件处理**：自动检测锁定进程，支持关闭后重试

### 🔗 软链接迁移（Junction）
- **无损搬迁**：将系统盘大目录迁移到其他磁盘，通过 Junction 保持原路径完全可用
- **6 步向导**：选择目录 → 目标盘 → 确认 → 迁移 → 备份 → 完成
- **一键回滚**：恢复原始目录结构并移除 Junction
- **健康监测**：定期检查已迁移目录的 Junction 状态

### 🗃 重复文件检测
- 基于文件大小预筛 + SHA-256 哈希精确比对，批量勾选删除

### 📊 每日监控与历史趋势
- 定时快照、7/30/90 天趋势图、异常增长告警、空间容量预测、系统健康评分

---

## 界面预览

| 总览 | 磁盘扫描 | 每日监控 |
|:----:|:--------:|:--------:|
| ![总览](docs/screenshots/overview.png) | ![磁盘扫描](docs/screenshots/disk-scan.png) | ![每日监控](docs/screenshots/daily-monitor.png) |

---

## 系统要求

| 项目 | 要求 |
|:-----|:-----|
| **操作系统** | Windows 10 / 11（x64） |
| **运行时** | 内置 Electron，无需额外安装 |
| **MFT 引擎**（可选） | .NET 9 Runtime — 可大幅提升扫描速度 |
| **开发环境** | Node.js 18+，npm |

---

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发模式
npm run dev
```

> Windows 用户也可直接双击 `start-dev.bat`。

### 构建安装包

```bash
# 默认构建（不混淆，方便改代码与调试）
npm run build          # 生成 Windows NSIS 安装包 → release/

# 可选：加固构建（obfuscator 混淆 + bytenode 字节码 + Electron Fuses）
npm run build:harden
```

构建流程：先发布本地 MFT 引擎（`native/mft-reader`）→ 全量构建 → （加固时才）代码硬化 → electron-builder 打包。

---

## 技术栈

| 层 | 技术 |
|:---|:-----|
| **前端** | React 18 · TypeScript · Tailwind CSS · Lucide Icons |
| **桌面** | Electron 33 |
| **数据** | better-sqlite3 |
| **快速扫描** | C# MFT Reader（.NET 9） |
| **构建** | electron-vite · electron-builder · javascript-obfuscator · bytenode |

---

<div align="center">

**MIT License**

</div>
