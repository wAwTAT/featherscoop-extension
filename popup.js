// popup.js — 弹窗主逻辑：扫描页面 → 展示附件 → 调用 downloads API 下载

import { scanInPage } from "./scanner.js";
import { refreshSsrInPage, readRefreshState } from "./ssr.js";
import { renderBlocksToMarkdown, renderSsrBlocksToMarkdown, startDocFetch } from "./doc_export.js";
import {
  DEFAULT_SETTINGS,
  buildDataUrl,
  buildDownloadPath,
  buildImageUrl,
  buildIndexMarkdown,
  buildPreviewUrl,
  categoryOf,
  escapeRegex,
  formatSize,
  safeBaseName,
  safeFileName,
  sanitizeRootDir,
} from "./shared.js";

const els = {
  rescanBtn: document.getElementById("rescanBtn"),
  stateCard: document.getElementById("stateCard"),
  stateTitle: document.getElementById("stateTitle"),
  stateDetail: document.getElementById("stateDetail"),
  docCard: document.getElementById("docCard"),
  docTitle: document.getElementById("docTitle"),
  exportDocBtn: document.getElementById("exportDocBtn"),
  docHost: document.getElementById("docHost"),
  fileCount: document.getElementById("fileCount"),
  listSection: document.getElementById("listSection"),
  listMeta: document.getElementById("listMeta"),
  fileList: document.getElementById("fileList"),
  selectAll: document.getElementById("selectAll"),
  settings: document.getElementById("settings"),
  rootDir: document.getElementById("rootDir"),
  groupByPrefix: document.getElementById("groupByPrefix"),
  skipExisting: document.getElementById("skipExisting"),
  makeIndex: document.getElementById("makeIndex"),
  progressWrap: document.getElementById("progressWrap"),
  progressFill: document.getElementById("progressFill"),
  progressText: document.getElementById("progressText"),
  selectedCount: document.getElementById("selectedCount"),
  downloadBtn: document.getElementById("downloadBtn"),
  openFolderBtn: document.getElementById("openFolderBtn"),
};

const state = {
  scanning: false,
  running: false,
  exporting: false,
  tabId: null,
  files: [],
  selected: new Set(),
  pageUrl: "",
  title: "",
  settings: { ...DEFAULT_SETTINGS },
  rows: new Map(),
  rootTimer: null,
};

init().catch((err) => {
  showState("error", "初始化失败", String(err && err.message ? err.message : err));
});

async function init() {
  bindUi();
  await loadSettings();
  await scan();
}

/* ---------------- 设置 ---------------- */

async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    state.settings = { ...DEFAULT_SETTINGS, ...stored };
  } catch (err) {
    state.settings = { ...DEFAULT_SETTINGS };
  }
  els.rootDir.value = state.settings.rootDir;
  els.groupByPrefix.checked = state.settings.groupByPrefix;
  els.skipExisting.checked = state.settings.skipExisting;
  els.makeIndex.checked = state.settings.makeIndex;
}

function bindUi() {
  els.rescanBtn.addEventListener("click", () => scan());
  els.selectAll.addEventListener("change", onSelectAll);
  els.downloadBtn.addEventListener("click", () => {
    startDownload().catch((err) => {
      state.running = false;
      refreshButtons();
      setProgress(0, "下载流程异常：" + (err && err.message ? err.message : err));
    });
  });
  els.openFolderBtn.addEventListener("click", () => {
    chrome.downloads.showDefaultFolder();
  });
  els.exportDocBtn.addEventListener("click", () => {
    exportDocument().catch((err) => {
      state.exporting = false;
      refreshButtons();
      setProgress(0, "导出失败：" + friendlyExportError(err));
    });
  });

  els.rootDir.addEventListener("input", () => {
    clearTimeout(state.rootTimer);
    state.rootTimer = setTimeout(saveRootDir, 500);
  });
  els.rootDir.addEventListener("change", saveRootDir);

  els.groupByPrefix.addEventListener("change", () => {
    state.settings.groupByPrefix = els.groupByPrefix.checked;
    chrome.storage.sync.set({ groupByPrefix: els.groupByPrefix.checked });
    refreshChips();
  });
  els.skipExisting.addEventListener("change", () => {
    state.settings.skipExisting = els.skipExisting.checked;
    chrome.storage.sync.set({ skipExisting: els.skipExisting.checked });
  });
  els.makeIndex.addEventListener("change", () => {
    state.settings.makeIndex = els.makeIndex.checked;
    chrome.storage.sync.set({ makeIndex: els.makeIndex.checked });
  });
}

function saveRootDir() {
  clearTimeout(state.rootTimer);
  state.rootTimer = null;
  const value = els.rootDir.value.trim();
  state.settings.rootDir = value;
  chrome.storage.sync.set({ rootDir: value });
}

/* ---------------- 扫描 ---------------- */

async function scan() {
  if (state.scanning || state.running || state.exporting) return;
  state.scanning = true;
  state.tabId = null;
  state.files = [];
  state.selected = new Set();
  state.rows.clear();
  els.fileList.replaceChildren();
  els.listSection.hidden = true;
  els.docCard.hidden = true;
  els.openFolderBtn.hidden = true;
  hideProgress();
  refreshButtons();
  showState("loading", "正在扫描页面…", "读取文档中的附件清单");
  els.rescanBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error("找不到当前标签页");

    const pageUrl = tab.url || tab.pendingUrl || "";
    if (!isSupportedPage(pageUrl)) {
      showState(
        "info",
        "请打开飞书文档页面",
        "支持飞书 / Lark 的 wiki、docx 等文档页面。打开文档后再点一次工具图标即可扫描附件或导出正文。"
      );
      return;
    }

    state.tabId = tab.id;

    // 飞书 wiki 是单页跳转，先确认页面里的 SSR 数据属于当前文档
    const freshState = await ensureFreshSsr(tab.id);
    if (freshState && freshState.stale && freshState.ok === false) {
      showState(
        "error",
        "文档已切换，需要刷新",
        "当前页面仍保留上一篇文档的数据，重新读取失败：" +
          (freshState.error || "未知错误") +
          "。请刷新当前文档后重试。"
      );
      return;
    }

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      func: scanInPage,
    });

    const frames = (injected || [])
      .map((entry) => entry && entry.result)
      .filter((result) => result && Array.isArray(result.files));

    const merged = new Map();
    for (const frame of frames) {
      for (const file of frame.files) {
        if (file && file.token && !merged.has(file.token)) merged.set(file.token, file);
      }
    }
    const files = Array.from(merged.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "zh-Hans-CN")
    );

    const most = frames.slice().sort((a, b) => b.files.length - a.files.length)[0];
    state.pageUrl = pageUrl;
    state.title =
      cleanTitle(most && (most.docTitle || most.pageTitle)) ||
      cleanTitle(tab.title) ||
      "飞书文档";
    state.files = files;
    state.selected = new Set(files.map((file) => file.token));

    els.stateCard.hidden = true;
    els.docTitle.textContent = state.title;
    els.fileCount.textContent = files.length + " 个附件";
    try {
      els.docHost.textContent = new URL(pageUrl).hostname;
    } catch (err) {
      els.docHost.textContent = "飞书";
    }
    els.listMeta.textContent = files.length + " 个附件";
    els.docCard.hidden = false;
    els.listSection.hidden = files.length === 0;

    if (files.length > 0) {
      renderFiles();
    } else {
      state.rows.clear();
      els.fileList.replaceChildren();
      syncSelectionUi();
      showState(
        "empty",
        frames.length > 0 ? "没有找到附件" : "未读取到附件清单",
        frames.length > 0
          ? "该文档可能没有文件附件；仍可点击右上角「导出文档」保存正文。"
          : "页面结构可能尚未加载完成；仍可尝试「导出文档」，或刷新文档后重新扫描。"
      );
      els.docCard.hidden = false;
    }
  } catch (err) {
    showState("error", "扫描失败", humanizeScanError(err));
  } finally {
    state.scanning = false;
    refreshButtons();
  }
}

/* ---------------- 渲染 ---------------- */

function renderFiles() {
  els.fileList.replaceChildren();
  state.rows.clear();

  for (const file of state.files) {
    const row = document.createElement("li");
    row.className = "file-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = state.selected.has(file.token);
    check.dataset.token = file.token;
    check.setAttribute("aria-label", "选择 " + file.name);
    check.addEventListener("change", onRowToggle);

    const main = document.createElement("div");
    main.className = "file-main";

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;

    const sub = document.createElement("div");
    sub.className = "file-sub";

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = categoryOf(file.name, state.settings.groupByPrefix);
    chip.hidden = !state.settings.groupByPrefix;

    const size = document.createElement("span");
    size.textContent = formatSize(file.size);

    sub.append(chip, size);
    main.append(name, sub);

    const status = document.createElement("span");
    status.className = "file-state";

    row.append(check, main, status);
    els.fileList.append(row);

    state.rows.set(file.token, { file, row, status, chip, check });
  }

  syncSelectionUi();
}

function refreshChips() {
  for (const entry of state.rows.values()) {
    entry.chip.hidden = !state.settings.groupByPrefix;
    entry.chip.textContent = categoryOf(entry.file.name, state.settings.groupByPrefix);
  }
}

function onRowToggle(event) {
  const token = event.target.dataset.token;
  if (event.target.checked) state.selected.add(token);
  else state.selected.delete(token);
  syncSelectionUi();
}

function onSelectAll() {
  const checked = els.selectAll.checked;
  state.selected = checked
    ? new Set(state.files.map((file) => file.token))
    : new Set();
  for (const entry of state.rows.values()) entry.check.checked = checked;
  syncSelectionUi();
}

function syncSelectionUi() {
  const total = state.files.length;
  const selected = state.files.filter((file) => state.selected.has(file.token)).length;

  els.selectAll.checked = total > 0 && selected === total;
  els.selectAll.indeterminate = selected > 0 && selected < total;
  els.selectedCount.textContent = "已选 " + selected + " / " + total + " 项";
  els.listMeta.textContent = total + " 个附件";

  refreshButtons();
}

function refreshButtons() {
  const selected = state.selected.size;
  const busy = state.running || state.exporting;
  els.downloadBtn.disabled = busy || state.scanning || selected === 0;
  els.downloadBtn.textContent = state.running ? "下载中…" : "下载";
  els.exportDocBtn.disabled = busy || state.scanning || !state.tabId;
  els.exportDocBtn.textContent = state.exporting ? "导出中…" : "导出文档";
  els.rescanBtn.disabled = busy || state.scanning;
}

function setRowState(token, kind, note) {
  const entry = state.rows.get(token);
  if (!entry) return;

  entry.status.dataset.kind = kind;
  let text = "";
  if (kind === "waiting") text = "等待";
  else if (kind === "queued") text = "排队";
  else if (kind === "downloading") text = note ? "↓ " + note : "↓";
  else if (kind === "done") text = "✓ 已保存";
  else if (kind === "skip") text = "已存在";
  else if (kind === "fail") text = "失败";
  entry.status.textContent = text;
  entry.status.title = note || "";
  entry.row.dataset.result = kind === "fail" ? "fail" : "";
}

/* ---------------- 下载 ---------------- */

async function startDownload() {
  if (state.running || state.scanning || state.exporting) return;
  const files = state.files.filter((file) => state.selected.has(file.token));
  if (files.length === 0) return;

  state.running = true;
  refreshButtons();

  const root = sanitizeRootDir(els.rootDir.value || state.settings.rootDir);
  const total = files.length;
  const tracked = new Map();
  const indexEntries = [];
  let finished = 0;
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  els.openFolderBtn.hidden = true;
  els.progressWrap.hidden = false;
  setProgress(0, "准备下载 " + total + " 个文件…");

  for (const file of files) {
    const dir = categoryOf(file.name, state.settings.groupByPrefix);
    const fileName = safeFileName(file.name);
    const relPath = buildDownloadPath(root, dir, fileName);
    setRowState(file.token, "waiting");

    try {
      if (
        state.settings.skipExisting &&
        file.size > 0 &&
        (await existsWithSize(relPath, file.size))
      ) {
        skipped += 1;
        finished += 1;
        setRowState(file.token, "skip");
        indexEntries.push({ name: fileName, dir });
        updateProgress(finished, total, ok, skipped, failed);
        continue;
      }

      const url = buildPreviewUrl(state.pageUrl, file.token);
      const downloadId = await chrome.downloads.download({
        url,
        filename: relPath,
        conflictAction: "overwrite",
        saveAs: false,
      });
      tracked.set(downloadId, {
        token: file.token,
        name: fileName,
        dir,
      });
      setRowState(file.token, "queued");
    } catch (err) {
      failed += 1;
      finished += 1;
      setRowState(file.token, "fail", explainDownloadError(err));
      updateProgress(finished, total, ok, skipped, failed);
    }

    // 轻微错峰，避免一次性触发过多下载
    await sleep(90);
  }

  const pollStartedAt = Date.now();
  while (tracked.size > 0) {
    const ids = Array.from(tracked.keys());
    const results = await Promise.all(
      ids.map((id) =>
        chrome.downloads.search({ id }).catch(() => [])
      )
    );

    for (const items of results) {
      for (const item of items) {
        const meta = tracked.get(item.id);
        if (!meta) continue;

        if (item.state === "complete") {
          tracked.delete(item.id);
          finished += 1;
          if (!item.exists) {
            failed += 1;
            setRowState(meta.token, "fail", "文件未落盘");
          } else if (looksLikeLoginPage(item, meta.name)) {
            failed += 1;
            setRowState(meta.token, "fail", "返回了网页（登录态可能失效）");
          } else {
            ok += 1;
            setRowState(meta.token, "done");
            indexEntries.push({ name: meta.name, dir: meta.dir });
          }
        } else if (item.state === "interrupted") {
          tracked.delete(item.id);
          finished += 1;
          failed += 1;
          setRowState(meta.token, "fail", explainDownloadError(item.error));
        } else if (item.paused) {
          tracked.delete(item.id);
          finished += 1;
          failed += 1;
          setRowState(meta.token, "fail", "下载已暂停");
        } else {
          const pct = item.totalBytes > 0
            ? Math.round((item.bytesReceived / item.totalBytes) * 100) + "%"
            : "";
          setRowState(meta.token, "downloading", pct);
        }
      }
    }

    updateProgress(finished, total, ok, skipped, failed);

    if (tracked.size === 0) break;
    if (Date.now() - pollStartedAt > 30 * 60 * 1000) {
      for (const meta of tracked.values()) {
        failed += 1;
        finished += 1;
        setRowState(meta.token, "fail", "等待超时（下载可能仍在后台继续）");
      }
      tracked.clear();
      updateProgress(finished, total, ok, skipped, failed);
      break;
    }
    await sleep(600);
  }

  let indexNote = "";
  if (state.settings.makeIndex && indexEntries.length > 0) {
    const markdown = buildIndexMarkdown({
      title: state.title,
      sourceUrl: state.pageUrl,
      files: indexEntries,
    });
    try {
      await chrome.downloads.download({
        url: buildDataUrl(markdown),
        filename: root + "/README.md",
        conflictAction: "overwrite",
        saveAs: false,
      });
      indexNote = " · README 索引已生成";
    } catch (err) {
      indexNote = " · README 索引生成失败";
    }
  }

  els.openFolderBtn.hidden = ok + skipped === 0;
  const summary =
    "完成：" +
    ok + " 成功 · " +
    skipped + " 跳过 · " +
    failed + " 失败" +
    indexNote;
  setProgress(total > 0 ? 1 : 0, summary);
  els.progressFill.style.width = "100%";

  state.running = false;
  refreshButtons();
}

/* ---------------- 文档正文导出 ---------------- */

/** 让页面准备当前 URL 对应的 SSR 数据；返回 { ok, stale, error } */
async function ensureFreshSsr(tabId) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: refreshSsrInPage,
      args: [{ id }],
    });
    const direct = results && results[0] ? results[0].result : null;
    if (direct && typeof direct === "object" && direct.ok !== undefined) return direct;
  } catch (err) {
    return null;
  }

  // executeScript 未等待异步返回值时，轮询页面里写入的结果
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: readRefreshState,
      });
      const raw = results && results[0] ? results[0].result : null;
      if (!raw) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        parsed = null;
      }
      if (parsed && parsed.id === id && parsed.state) return parsed.state;
    } catch (err) {
      // ignore
    }
  }
  return null;
}

async function exportDocument() {
  if (state.exporting || state.running || state.scanning || !state.tabId) return;
  state.exporting = true;
  refreshButtons();
  els.openFolderBtn.hidden = true;
  setProgress(0.03, "正在读取文档内容…");

  const tabId = state.tabId;
  const tagId =
    "featherscoop-export-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  try {
    const freshState = await ensureFreshSsr(tabId);
    if (freshState && freshState.stale && freshState.ok === false) {
      throw new Error("页面内容已切换，请刷新当前文档后重试");
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: startDocFetch,
      args: [{ tagId }],
    });

    const payload = await waitForExport(tabId, tagId);
    if (!payload) throw new Error("读取文档超时，请刷新文档后重试");
    if (payload.status === "error") throw new Error(payload.error || "导出失败");

    setProgress(0.15, "正在生成 Markdown…");
    const rendered =
      payload.source === "ssr"
        ? renderSsrBlocksToMarkdown(payload, { grouping: state.settings.groupByPrefix })
        : renderBlocksToMarkdown(payload.blocks || [], {
            grouping: state.settings.groupByPrefix,
          });
    const title = cleanTitle(payload.title) || state.title || "飞书文档";
    const root = sanitizeRootDir(els.rootDir.value || state.settings.rootDir);
    const docName = safeBaseName(title) + ".md";
    const markdown = "# " + title + "\n\n" + rendered.markdown + "\n";

    // 先保存正文，再逐张下载图片；即使图片较多，用户也能马上拿到 Markdown
    setProgress(0.3, "正在保存 Markdown…");
    await chrome.downloads.download({
      url: buildDataUrl(markdown),
      filename: root + "/" + docName,
      conflictAction: "overwrite",
      saveAs: false,
    });

    let imageOk = 0;
    if (rendered.images.length > 0) {
      for (let i = 0; i < rendered.images.length; i += 1) {
        const image = rendered.images[i];
        try {
          await chrome.downloads.download({
            url: buildImageUrl(state.pageUrl, image.token),
            filename:
              root + "/_images/" + encodeURIComponent(image.token) + (image.ext || ".png"),
            conflictAction: "overwrite",
            saveAs: false,
          });
          imageOk += 1;
        } catch (err) {
          // 单张图片失败不阻塞正文导出
        }
        setProgress(
          0.3 + 0.65 * ((i + 1) / rendered.images.length),
          "正在下载图片 " + (i + 1) + "/" + rendered.images.length
        );
        await sleep(50);
      }
    } else {
      setProgress(0.95, "正在收尾…");
    }

    const imageNote =
      rendered.images.length > 0 ? " · 图片 " + imageOk + "/" + rendered.images.length : "";
    const partialNote =
      payload.incomplete > 0 ? " · 但部分内容未能加载（" + payload.incomplete + " 个单元格）" : "";
    setProgress(1, "文档已导出：" + docName + imageNote + partialNote);
    els.openFolderBtn.hidden = false;
  } catch (err) {
    setProgress(0, "导出失败：" + friendlyExportError(err));
  } finally {
    state.exporting = false;
    refreshButtons();
    cleanupExportMarker(tabId, tagId);
  }
}

async function waitForExport(tabId, tagId) {
  const deadline = Date.now() + 90 * 1000;
  while (Date.now() < deadline) {
    await sleep(400);
    let raw = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: readExportMarker,
        args: [tagId],
      });
      raw = results && results[0] ? results[0].result : null;
    } catch (err) {
      raw = null;
    }
    if (!raw) continue;

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parsed = null;
    }
    if (!parsed) continue;
    if (parsed.status === "pending") continue;
    return parsed;
  }
  return null;
}

function readExportMarker(tagId) {
  const el = document.getElementById(tagId);
  return el ? el.textContent : null;
}

function cleanupExportMarker(tabId, tagId) {
  try {
    chrome
      .scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: cleanupExportMarkerInPage,
        args: [tagId],
      })
      .catch(() => {});
  } catch (err) {
    // ignore
  }
}

function cleanupExportMarkerInPage(tagId) {
  const el = document.getElementById(tagId);
  if (el) el.remove();
}

function friendlyExportError(err) {
  const message = String(err && err.message ? err.message : err);
  if (/接口返回非 JSON|HTTP 40[134]/.test(message)) {
    return message + "。请确认已登录、能正常打开该文档，并且当前账号有阅读权限。";
  }
  if (/Cannot access contents|No tab with id|Could not establish connection/i.test(message)) {
    return "无法在当前页面执行导出，请刷新文档后重试。";
  }
  return message;
}

function updateProgress(finished, total, ok, skipped, failed) {
  const ratio = total > 0 ? Math.min(1, finished / total) : 0;
  setProgress(
    ratio,
    "已处理 " + finished + "/" + total +
      " · 成功 " + ok + " · 跳过 " + skipped + " · 失败 " + failed
  );
}

function setProgress(ratio, text) {
  els.progressWrap.hidden = false;
  els.progressFill.style.width = Math.round(ratio * 100) + "%";
  els.progressText.textContent = text;
}

function hideProgress() {
  els.progressWrap.hidden = true;
  els.progressFill.style.width = "0%";
  els.progressText.textContent = "";
}

/* ---------------- 下载辅助 ---------------- */

async function existsWithSize(relPath, size) {
  const parts = relPath.split("/").filter(Boolean).map(escapeRegex);
  const regex = "(^|[\\\\/])" + parts.join("[\\\\/]") + "$";
  try {
    const items = await chrome.downloads.search({
      filenameRegex: regex,
      exists: true,
      state: "complete",
    });
    return items.some((item) => item.fileSize === size);
  } catch (err) {
    return false;
  }
}

function looksLikeLoginPage(item, fileName) {
  if (item.mime !== "text/html") return false;
  return !/\.(html?|htm|txt)$/i.test(fileName);
}

function explainDownloadError(error) {
  const detail = typeof error === "string" ? error : (error && error.message) || "";
  const map = {
    SERVER_FORBIDDEN: "403 权限不足：分享者可能限制了下载",
    SERVER_UNAUTHORIZED: "401 未登录或登录已过期",
    SERVER_BAD_CONTENT: "服务器返回内容异常",
    SERVER_FAILED: "服务器错误",
    NETWORK_FAILED: "网络请求失败",
    NETWORK_TIMEOUT: "网络超时",
    NETWORK_DISCONNECTED: "网络连接已断开",
    FILE_ACCESS_DENIED: "无法写入下载目录",
    FILE_NO_SPACE: "磁盘空间不足",
    FILE_TOO_LARGE: "文件过大",
    INVALID_FILENAME: "文件名或目录不合法",
    USER_CANCELED: "下载已取消",
    CRASH: "下载进程异常退出",
  };
  if (map[detail]) return map[detail];
  if (/invalid filename/i.test(detail)) return "文件名或目录不合法";
  if (/invalid url/i.test(detail)) return "下载地址无效";
  if (/canceled|cancelled/i.test(detail)) return "下载已取消";
  return detail || "下载失败";
}

/* ---------------- 通用辅助 ---------------- */

function isSupportedPage(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      /(^|\.)feishu\.cn$/.test(host) ||
      /(^|\.)larksuite\.com$/.test(host) ||
      /(^|\.)larkoffice\.com$/.test(host)
    );
  } catch (err) {
    return false;
  }
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s*[-|–—]\s*(飞书云文档|飞书|Lark|Feishu)\s*$/i, "")
    .trim();
}

function humanizeScanError(err) {
  const message = String(err && err.message ? err.message : err);
  if (/Cannot access contents|Missing host permission|The extensions gallery|chrome:\/\//i.test(message)) {
    return "当前页面不允许扩展读取，请确认打开的是飞书文档页（wiki / docx）。";
  }
  if (/No tab with id|找不到当前标签页/i.test(message)) {
    return "标签页已关闭，请重新打开文档后再试。";
  }
  return message;
}

function showState(kind, title, detail) {
  els.stateCard.hidden = false;
  els.stateCard.dataset.kind = kind;
  els.stateTitle.textContent = title;
  els.stateDetail.textContent = detail;
  els.docCard.hidden = true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
