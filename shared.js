// shared.js — 与下载规则相关的小工具（纯函数，便于测试）

export const DEFAULT_SETTINGS = {
  rootDir: "FeatherScoop",
  groupByPrefix: true,
  skipExisting: true,
  makeIndex: true,
};

const ILLEGAL_CHARS = /[\\/:*?"<>|\r\n\t]/g;

/** 清洗单个路径片段（文件名或目录名） */
export function sanitizeSegment(input, fallback = "untitled") {
  let name = String(input == null ? "" : input)
    .replace(ILLEGAL_CHARS, "_")
    .trim();
  name = name.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  if (!name) name = fallback;
  return name.slice(0, 160);
}

/** 只清洗文档标题，不追加扩展名（用于 Markdown 文件名） */
export function safeBaseName(input) {
  return sanitizeSegment(input, "未命名文档").slice(0, 120) || "未命名文档";
}

/** 清洗保存根目录：只保留相对路径片段，过滤盘符、.. 等非法内容 */
export function sanitizeRootDir(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return DEFAULT_SETTINGS.rootDir;
  const parts = raw.split(/[\\/]+/);
  const kept = [];
  for (const part of parts) {
    const segment = part.trim();
    if (!segment) continue;
    if (/^[A-Za-z]:$/.test(segment)) continue;
    if (segment === "." || segment === "..") continue;
    const clean = sanitizeSegment(segment, "");
    if (clean) kept.push(clean);
  }
  return kept.join("/") || DEFAULT_SETTINGS.rootDir;
}

/** 保留原文件名与扩展名，非法字符替换为下划线（默认无扩展名时补 .pdf，与 CLI 行为一致） */
export function safeFileName(name) {
  const raw = String(name == null ? "" : name).trim() || "untitled";
  const dot = raw.lastIndexOf(".");
  const hasExt = dot > 0 && dot < raw.length - 1;
  let base = hasExt ? raw.slice(0, dot) : raw;
  let ext = hasExt ? raw.slice(dot) : ".pdf";

  base = sanitizeSegment(base, "untitled");
  ext = ext.replace(/[\\/:*?"<>|\r\n\t]/g, "").slice(0, 24);
  if (!ext || ext === ".") ext = ".pdf";

  const maxBase = Math.max(1, 180 - ext.length);
  if (base.length > maxBase) base = base.slice(0, maxBase).trim() || "untitled";
  return base + ext;
}

/** 分组规则：文件名以「【资料】」开头 → 访谈嘉宾资料，其余 → 其他资料 */
export function categoryOf(name, grouping = true) {
  if (!grouping) return "";
  return String(name || "").startsWith("【资料】") ? "访谈嘉宾资料" : "其他资料";
}

/** 拼出 chrome.downloads 使用的相对路径 */
export function buildDownloadPath(rootDir, category, fileName) {
  return [sanitizeRootDir(rootDir), sanitizeSegment(category, ""), fileName]
    .filter(Boolean)
    .join("/");
}

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "大小未知";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 根据页面所在租户，返回对应的预览流服务域名 */
export function previewBaseFor(pageUrl) {
  let host = "";
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch (err) {
    host = "";
  }
  if (host === "larksuite.com" || host.endsWith(".larksuite.com")) {
    return "https://internal-api-drive-stream.larksuite.com";
  }
  if (host === "larkoffice.com" || host.endsWith(".larkoffice.com")) {
    return "https://internal-api-drive-stream.larkoffice.com";
  }
  return "https://internal-api-drive-stream.feishu.cn";
}

/** 关键突破点：分享者关闭下载后 download/all 会 403，但 preview 流仍返回原始文件 */
export function buildPreviewUrl(pageUrl, token) {
  const base = previewBaseFor(pageUrl);
  return (
    base +
    "/space/api/box/stream/download/preview/" +
    encodeURIComponent(token) +
    "?preview_type=16&mount_point=docx_file"
  );
}

/** 文档内嵌图片的下载地址：预览流同样能拿到原图，且不受「禁止下载」影响 */
export function buildImageUrl(pageUrl, token) {
  const base = previewBaseFor(pageUrl);
  return (
    base +
    "/space/api/box/stream/download/preview/" +
    encodeURIComponent(token) +
    "?preview_type=16&mount_point=docx_file"
  );
}

/** 生成带链接的 README 索引（与原 CLI 的输出保持一致的结构） */
export function buildIndexMarkdown(options) {
  const title = String(options.title || "飞书文档附件合集");
  const sourceUrl = options.sourceUrl || "";
  const files = options.files || [];
  const groups = new Map();

  for (const file of files) {
    const dir = file.dir || "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file.name);
  }

  let md = "# " + title + "\n\n";
  md += "> 📄 共 " + files.length + " 个文件\n";
  md += "> ⏰ 整理时间: " + new Date().toLocaleString("zh-CN") + "\n";
  if (sourceUrl) md += "> 🔗 来源: " + sourceUrl + "\n";
  md += "\n---\n\n";

  for (const [dir, list] of groups) {
    list.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    md += "## 📁 " + (dir || "附件") + "（共 " + list.length + " 个）\n\n";
    for (const name of list) {
      const href = dir
        ? "./" + encodeURIComponent(dir) + "/" + encodeURIComponent(name)
        : "./" + encodeURIComponent(name);
      md += "- [📄 " + name + "](" + href + ")\n";
    }
    md += "\n";
  }
  return md;
}

/** 数据 URL 下载（用于生成 README.md，无需额外权限） */
export function buildDataUrl(markdown) {
  return "data:text/markdown;charset=utf-8," + encodeURIComponent(markdown);
}
