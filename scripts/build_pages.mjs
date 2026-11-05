/**
 * GitHub Pages 静态构建与“按 Commit 归档部署 (Deployment by Commits)”打包脚本
 * 仅依赖 Node.js 内置模块 (fs, path, child_process)，无需任何第三方构建依赖。
 *
 * 产出目录结构 (./dist):
 *   ├── index.html                 (最新 main HEAD 版本可玩入口)
 *   ├── src/                       (最新 main HEAD 源码模块)
 *   ├── specs/                     (最新 SDD 规范文档)
 *   ├── version.json               (当前构建的 Git Commit 元数据)
 *   └── commits/
 *       ├── index.html             (可视化“按 Commit 试玩归档中心 / 版本时光机”)
 *       ├── manifest.json          (所有可玩 Commit 列表 JSON)
 *       └── <short-sha>/           (每一个历史 Commit 的独立可玩快照!)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const COMMITS_DIR = path.join(DIST_DIR, 'commits');
const MAX_COMMIT_SNAPSHOTS = 35;

function runGit(cmd) {
  return execSync(`git ${cmd}`, { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
}

function hasFileInCommit(sha, filePath) {
  try {
    execSync(`git cat-file -e ${sha}:${filePath}`, { cwd: ROOT_DIR, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 1. 清理并初始化 ./dist 目录
fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(COMMITS_DIR, { recursive: true });
fs.writeFileSync(path.join(DIST_DIR, '.nojekyll'), '');

// 2. 拷贝当前最新工作区代码到 ./dist 根目录
fs.cpSync(path.join(ROOT_DIR, 'index.html'), path.join(DIST_DIR, 'index.html'));
fs.cpSync(path.join(ROOT_DIR, 'src'), path.join(DIST_DIR, 'src'), { recursive: true });
if (fs.existsSync(path.join(ROOT_DIR, 'specs'))) {
  fs.cpSync(path.join(ROOT_DIR, 'specs'), path.join(DIST_DIR, 'specs'), { recursive: true });
}
if (fs.existsSync(path.join(ROOT_DIR, 'README.md'))) {
  fs.cpSync(path.join(ROOT_DIR, 'README.md'), path.join(DIST_DIR, 'README.md'));
}

// 3. 读取 Git 提交历史，筛选包含可玩入口 (index.html + src/main.js) 的全部 Commits
const rawLog = runGit(`log -n ${MAX_COMMIT_SNAPSHOTS} --format="%H|%h|%cI|%an|%s"`);
const logLines = rawLog.split('\n').filter(Boolean);

const playableCommits = [];

for (const line of logLines) {
  const [sha, shortSha, dateIso, author, ...subjectParts] = line.split('|');
  const subject = subjectParts.join('|');
  if (!hasFileInCommit(sha, 'index.html') || !hasFileInCommit(sha, 'src/main.js')) {
    continue;
  }

  const targetCommitDir = path.join(COMMITS_DIR, shortSha);
  fs.mkdirSync(targetCommitDir, { recursive: true });

  // 使用 git archive 将该历史 Commit 的完整代码导出到 ./dist/commits/<shortSha>/
  execSync(`git archive ${sha} index.html src | tar -x -C "${targetCommitDir}"`, {
    cwd: ROOT_DIR,
  });

  // 在历史快照的 index.html 中注入顶部小型“历史 Commit 快照指示横幅”，方便一键返回最新或切换其他 Commit
  const snapIndexHtmlPath = path.join(targetCommitDir, 'index.html');
  if (fs.existsSync(snapIndexHtmlPath)) {
    let html = fs.readFileSync(snapIndexHtmlPath, 'utf8');
    const bannerSnippet = `
    <div style="position:fixed;bottom:62px;left:14px;z-index:9999;background:rgba(15,23,42,0.92);border:1px solid rgba(245,158,11,0.65);border-radius:8px;padding:6px 12px;font-size:11px;color:#fef3c7;display:flex;align-items:center;gap:10px;box-shadow:0 8px 20px rgba(0,0,0,0.6);backdrop-filter:blur(6px);">
      <span>⏱️ <b>历史 Commit 快照</b>: <code style="color:#38bdf8;font-weight:bold;">${escapeHtml(shortSha)}</code></span>
      <span style="color:#94a3b8;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(subject)}">${escapeHtml(subject)}</span>
      <a href="../index.html" style="color:#fbbf24;text-decoration:none;font-weight:bold;border:1px solid rgba(251,191,36,0.4);padding:2px 7px;border-radius:4px;background:rgba(245,158,11,0.15);">📜 所有 Commits</a>
      <a href="../../index.html" style="color:#34d399;text-decoration:none;font-weight:bold;border:1px solid rgba(52,211,153,0.4);padding:2px 7px;border-radius:4px;background:rgba(16,185,129,0.15);">🚀 最新主线版</a>
    </div>
    </body>`;
    html = html.replace('</body>', bannerSnippet);
    fs.writeFileSync(snapIndexHtmlPath, html, 'utf8');
  }

  playableCommits.push({
    sha,
    shortSha,
    dateIso,
    author,
    subject,
    playUrl: `./${shortSha}/index.html`,
    githubUrl: `https://github.com/fenghaolw/san9/commit/${sha}`,
  });
}

// 4. 生成根目录下当前构建版本元数据 version.json
const headCommit = playableCommits[0] || {
  sha: 'HEAD',
  shortSha: 'HEAD',
  dateIso: new Date().toISOString(),
  author: 'Developer',
  subject: 'Latest Build',
};

fs.writeFileSync(
  path.join(DIST_DIR, 'version.json'),
  JSON.stringify(
    {
      latest: headCommit,
      totalSnapshots: playableCommits.length,
      builtAt: new Date().toISOString(),
    },
    null,
    2
  )
);

// 5. 生成 ./dist/commits/manifest.json 与可视化门户 ./dist/commits/index.html
fs.writeFileSync(path.join(COMMITS_DIR, 'manifest.json'), JSON.stringify(playableCommits, null, 2));

const commitsPortalHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>《中原逐鹿》GitHub Pages 按 Commit 历史版本归档与试玩中心</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans selection:bg-amber-500 selection:text-slate-950">
  <div class="max-w-5xl mx-auto px-6 py-10">
    <!-- 顶部横幅 -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-amber-500/30">
      <div>
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold mb-2">
          <span>⏱️ Spec-Driven Development · Per-Commit Playable Archive</span>
        </div>
        <h1 class="text-2xl md:text-3xl font-black text-amber-200 tracking-wide">
          《三国志9 × P社大战略：中原逐鹿》Commit 版本时光机
        </h1>
        <p class="text-sm text-slate-400 mt-1">
          每一次推送到 GitHub 的 Commit 均经过确定性规范测试验证，并在此生成独立可玩的沙盘快照，方便随时对比不同演进阶段的渲染、网格与系统设计。
        </p>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <a href="../index.html" class="px-4 py-2.5 rounded-lg bg-gradient-to-r from-amber-500 to-red-600 hover:from-amber-400 hover:to-red-500 text-white font-black text-sm shadow-lg">
          🚀 进入最新主线版 (${escapeHtml(headCommit.shortSha)})
        </a>
        <a href="https://github.com/fenghaolw/san9/commits/main" target="_blank" rel="noreferrer" class="px-3.5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold">
          GitHub 仓库记录 ↗
        </a>
      </div>
    </div>

    <!-- 历史可玩 Commit 列表 -->
    <div class="mt-8 space-y-3">
      ${playableCommits
        .map(
          (c, idx) => `
        <div class="p-4 rounded-xl bg-slate-900/85 border ${
          idx === 0 ? 'border-amber-400/70 ring-1 ring-amber-400/30' : 'border-slate-800 hover:border-slate-700'
        } flex flex-col md:flex-row md:items-center justify-between gap-4 transition">
          <div class="space-y-1">
            <div class="flex items-center gap-2.5 flex-wrap">
              <span class="px-2 py-0.5 rounded font-mono text-xs font-bold ${
                idx === 0 ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-sky-300 border border-slate-700'
              }">
                ${escapeHtml(c.shortSha)}
              </span>
              ${
                idx === 0
                  ? '<span class="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold">当前最新 (HEAD)</span>'
                  : `<span class="text-xs text-slate-500">历史快照 #${playableCommits.length - idx}</span>`
              }
              <span class="text-xs text-slate-400 font-mono">${escapeHtml(c.dateIso.replace('T', ' ').slice(0, 19))}</span>
            </div>
            <div class="text-base font-bold text-amber-100">
              ${escapeHtml(c.subject)}
            </div>
          </div>
          <div class="flex items-center gap-2.5 shrink-0">
            <a href="${escapeHtml(c.playUrl)}" class="px-4 py-2 rounded-lg ${
            idx === 0
              ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-black'
              : 'bg-slate-800 hover:bg-slate-700 border border-amber-500/40 text-amber-200 font-bold'
          } text-xs transition">
              🎮 试玩此 Commit 快照
            </a>
            <a href="${escapeHtml(c.githubUrl)}" target="_blank" rel="noreferrer" class="px-3 py-2 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 text-xs font-mono">
              源码 Diff ↗
            </a>
          </div>
        </div>
      `
        )
        .join('\n')}
    </div>
  </div>
</body>
</html>`;

fs.writeFileSync(path.join(COMMITS_DIR, 'index.html'), commitsPortalHtml, 'utf8');

console.log(`✅ GitHub Pages 构建完成！共生成 1 个最新主线版本 + ${playableCommits.length} 个历史 Commit 独立可玩快照。`);
