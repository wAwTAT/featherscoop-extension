// doc_export.js — 飞书 docx 正文导出：页面内拉取 block 数据，弹窗内渲染 Markdown

import { safeFileName } from "./shared.js";

/** 根据图片 MIME 推断本地扩展名 */
function imageExt(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.indexOf("jpeg") >= 0 || mime.indexOf("jpg") >= 0) return ".jpg";
  if (mime.indexOf("gif") >= 0) return ".gif";
  if (mime.indexOf("webp") >= 0) return ".webp";
  if (mime.indexOf("svg") >= 0) return ".svg";
  if (mime.indexOf("bmp") >= 0) return ".bmp";
  if (mime.indexOf("tiff") >= 0) return ".tiff";
  return ".png";
}

/**
 * 该函数会被 chrome.scripting.executeScript 注入到文档页面的 MAIN world 执行。
 * 它只负责取数据，把结果写进一个隐藏 div（marker），由弹窗轮询读取。
 * 注意：函数体必须完全自包含，不能引用模块作用域变量。
 */
export function startDocFetch(config) {
  const conf = config || {};
  const tagId = conf.tagId || "featherscoop-export";
  const marker = document.createElement("div");
  marker.id = tagId;
  marker.style.display = "none";
  marker.textContent = JSON.stringify({ status: "pending" });
  (document.body || document.documentElement).appendChild(marker);
  setTimeout(function () {
    try {
      if (marker.parentNode) marker.parentNode.removeChild(marker);
    } catch (err) {
      // ignore
    }
  }, 120000);

  function write(payload) {
    marker.textContent = JSON.stringify(payload);
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      json = null;
    }
    if (!json) throw new Error("接口返回非 JSON（HTTP " + res.status + "）");
    if (json.code !== 0 && json.code != null) {
      throw new Error(json.msg || "接口错误 code=" + json.code);
    }
    return json.data || {};
  }

  (async function () {
    try {
      const pathname = String(location.pathname || "");
      let title = "";
      let cvData = null;

      try {
        const cv = window.DATA && window.DATA.clientVars;
        cvData = cv && cv.data;
        const meta = window.DATA && window.DATA.meta;
        if (meta && meta.title) title = meta.title;
        if (!title && cvData) title = cvData.title || "";
      } catch (err) {
        cvData = null;
      }
      if (!title) {
        try {
          title = document.title || "";
        } catch (err) {
          title = "";
        }
      }

      // 单页跳转后 window.DATA 仍是旧文档；refreshSsrInPage 会缓存当前 URL 的正文
      let fresh = null;
      try {
        const cache = window.__featherscoopSsrCache;
        if (cache && cache.blockMap && cache.url === String(location.href || "")) fresh = cache;
      } catch (err) {
        fresh = null;
      }

      // SSR 只内嵌一部分 block（大表格的单元格会走分页接口），这里按页补齐
      async function fillRemaining(sourceCv, map, seq) {
        let meta = {};
        try {
          meta = (window.DATA && window.DATA.meta) || {};
        } catch (err) {
          meta = {};
        }
        let token = meta.token || "";
        try {
          const wiki = window.current_space_wiki || {};
          token = token || wiki.obj_token || "";
        } catch (err) {
          // ignore
        }
        if (!token && sourceCv) token = sourceCv.obj_token || "";
        if (!token) return 0;

        const startCursors = Array.isArray(sourceCv && sourceCv.next_cursors)
          ? sourceCv.next_cursors.slice(0, 40)
          : [];
        // 所有模式共享请求预算，避免大文档拖慢导出
        let budget = 30;

        // 页面自己加载过的分页数据（由 inject.js 在 MAIN world 拦截并缓存）
        try {
          const cache = window.__featherscoopBlockCache;
          const slot = cache && cache.byToken && cache.byToken[token];
          if (slot && slot.blockMap) {
            const cached = Object.keys(slot.blockMap);
            for (let i = 0; i < cached.length; i += 1) {
              const id = cached[i];
              if (!map[id]) map[id] = slot.blockMap[id];
            }
            const cachedSeq = slot.blockSequence || [];
            for (let i = 0; i < cachedSeq.length; i += 1) {
              if (seq.indexOf(cachedSeq[i]) < 0) seq.push(cachedSeq[i]);
            }
          }
        } catch (err) {
          // 没有缓存时忽略
        }

        async function pull(mode, cursors) {
          const queue = cursors.slice();
          const seen = {};
          let added = 0;
          let emptyStreak = 0;
          while (budget > 0) {
            let cursor = "";
            if (queue.length) {
              cursor = queue.shift();
              if (!cursor || seen[cursor]) continue;
              seen[cursor] = 1;
            }
            budget -= 1;
            let json = null;
            try {
              const url =
                "/space/api/docx/pages/client_vars?id=" +
                encodeURIComponent(token) +
                "&mode=" +
                encodeURIComponent(mode) +
                "&limit=239" +
                (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
              const res = await fetch(url, {
                credentials: "include",
                headers: { Accept: "application/json, text/plain, */*" },
              });
              if (!res.ok) return added;
              json = await res.json();
            } catch (err) {
              return added;
            }
            if (!json || json.code !== 0) return added;
            const data = json.data || {};
            const more = data.block_map || {};
            const ids = Object.keys(more);
            let fresh = 0;
            for (let i = 0; i < ids.length; i += 1) {
              const id = ids[i];
              if (!map[id]) {
                map[id] = more[id];
                fresh += 1;
              }
            }
            added += fresh;
            const moreSeq = Array.isArray(data.block_sequence) ? data.block_sequence : [];
            for (let i = 0; i < moreSeq.length; i += 1) {
              if (seq.indexOf(moreSeq[i]) < 0) seq.push(moreSeq[i]);
            }
            const next = Array.isArray(data.next_cursors) ? data.next_cursors : [];
            for (let i = 0; i < next.length; i += 1) queue.push(next[i]);
            if (data.has_more && data.cursor) queue.push(data.cursor);
            if (!queue.length) return added;
            if (ids.length === 0) return added;
            emptyStreak = fresh === 0 ? emptyStreak + 1 : 0;
            if (emptyStreak >= 2) return added;
          }
          return added;
        }

        // 大表格单元格属于 skip block：先用 SSR 游标试 table_skip_block，
        // 再试普通块，最后补折叠块
        let added = await pull("table_skip_block", startCursors);
        added += await pull("normal_block", startCursors);
        if (added === 0) added += await pull("table_skip_block", []);
        added += await pull("foldable_skip_block", []);
        return added;
      }

      // 统计仍然缺失的表格单元格，用于提示导出是否完整
      function countMissingCells(map) {
        let missing = 0;
        const ids = Object.keys(map);
        for (let i = 0; i < ids.length; i += 1) {
          const data = (map[ids[i]] && map[ids[i]].data) || {};
          if (data.type !== "table") continue;
          const cells = data.cell_set || {};
          const keys = Object.keys(cells);
          for (let j = 0; j < keys.length; j += 1) {
            const cell = cells[keys[j]];
            if (cell && cell.block_id && !map[cell.block_id]) missing += 1;
          }
        }
        return missing;
      }

      if (fresh) {
        const map = fresh.blockMap;
        const seq = fresh.blockSequence || Object.keys(map);
        let incomplete = 0;
        if (fresh.hasMore) {
          try {
            await fillRemaining(
              { next_cursors: fresh.nextCursors || [], obj_token: fresh.objToken || "" },
              map,
              seq
            );
            incomplete = countMissingCells(map);
          } catch (err) {
            incomplete = 1;
          }
        }
        write({
          status: "done",
          source: "ssr",
          title: fresh.title || title,
          blockMap: map,
          blockSequence: seq,
          incomplete: incomplete,
          pageUrl: String(location.href || ""),
        });
        return;
      }

      // 首选：页面 SSR 数据。只读分享文档可能没有 API 权限，但页面本身一定能读到正文
      if (cvData && cvData.block_map) {
        let stale = false;
        try {
          stale = Boolean(window.__featherscoopSsrStale);
        } catch (err) {
          stale = false;
        }
        if (stale) throw new Error("页面内容已切换，请刷新当前文档后重试");
        const map = cvData.block_map;
        const keys = Object.keys(map);
        if (keys.length > 0) {
          const seq = Array.isArray(cvData.block_sequence) ? cvData.block_sequence.slice() : keys;
          let incomplete = 0;
          if (cvData.has_more) {
            try {
              await fillRemaining(cvData, map, seq);
              incomplete = countMissingCells(map);
            } catch (err) {
              incomplete = 1;
            }
          }
          write({
            status: "done",
            source: "ssr",
            title: title,
            blockMap: map,
            blockSequence: seq,
            incomplete: incomplete,
            pageUrl: String(location.href || ""),
          });
          return;
        }
      }

      // 兜底：调飞书 API（部分页面没有 SSR block_map）
      let objToken = "";
      let objType = "";

      const wikiMatch = pathname.match(/\/wiki\/([A-Za-z0-9]+)\/?$/);
      if (wikiMatch) {
        const info = await post("/space/api/wiki/v2/token_info/", {
          wiki_token: wikiMatch[1],
          need_parse_attr: true,
        });
        const node = info.node || {};
        objToken = node.obj_token || "";
        objType = node.obj_type || "";
        title = node.title || title;
      } else {
        const directMatch = pathname.match(/\/(docx|docs|sheets|base)\/([A-Za-z0-9]+)/);
        if (directMatch) {
          objType = directMatch[1] === "docx" ? "docx" : directMatch[1];
          objToken = directMatch[2];
        }
      }

      try {
        const data = cvData;
        if (data) {
          if (!objToken) objToken = data.obj_token || "";
          if (!objType) objType = data.obj_type || "";
          if (!title) title = data.title || "";
        }
      } catch (err) {
        // ignore
      }

      if (!objToken) throw new Error("无法识别当前文档，请确认打开的是文档正文页面");

      const typeLabels = { docs: "旧版文档", sheets: "表格", base: "多维表格" };
      if (objType && objType !== "docx") {
        throw new Error(
          "暂不支持「" + (typeLabels[objType] || objType) + "」类型的正文导出，目前支持 docx / wiki docx"
        );
      }

      const data = await post("/space/api/obj/" + encodeURIComponent(objToken) + "/", {
        need_parse_block: true,
        need_extra_info: false,
        need_doc_gen_info: true,
        token: objToken,
      });
      const blocks = data.block || data.blocks || [];
      if (!Array.isArray(blocks) || blocks.length === 0) {
        throw new Error("文档内容为空或读取失败");
      }

      write({
        status: "done",
        source: "api",
        title: title,
        objType: objType || "docx",
        objToken: objToken,
        blocks: blocks,
        pageUrl: String(location.href || ""),
      });
    } catch (err) {
      write({ status: "error", error: String(err && err.message ? err.message : err) });
    }
  })();
}

/**
 * 将飞书 docx block 数组渲染为 Markdown。
 * 兼容 /space/api/obj/{token}/ 返回的 block 结构（block_type 为数字）。
 * 返回 { markdown, images }，images 为去重后的 { token, ext } 列表。
 */
export function renderBlocksToMarkdown(blocks, options) {
  const opts = options || {};
  const grouping = opts.grouping !== false;
  const byId = new Map();
  for (const block of blocks) {
    if (block && block.block_id) byId.set(block.block_id, block);
  }

  const images = [];
  const imageSeen = new Set();

  function textToMd(textBlock) {
    const elements = (textBlock && textBlock.elements) || [];
    let out = "";
    for (const element of elements) {
      const run = element.text_run || {};
      let content = run.content || "";
      const style = run.text_element_style || {};
      if (style.bold) content = "**" + content + "**";
      if (style.italic) content = "*" + content + "*";
      if (style.underline) content = "<u>" + content + "</u>";
      if (style.strike_through) content = "~~" + content + "~~";
      if (style.inline_code) content = "`" + content + "`";
      const link = style.link || {};
      if (link.url) content = "[" + content + "](" + link.url + ")";
      out += content;
    }
    return out;
  }

  function blockToMd(block, allBlocks) {
    if (!block || typeof block !== "object") return "";
    const type = block.block_type;
    const data = block.data && typeof block.data === "object" ? block.data : {};
    const text = block.text || data.text || {};

    if (type === 1) return textToMd(text) + "\n";
    if (type >= 2 && type <= 10) {
      const level = Math.min(6, type - 1);
      return "#".repeat(level) + " " + textToMd(text) + "\n";
    }
    if (type === 11) return "- " + textToMd(text) + "\n";
    if (type === 12) return "1. " + textToMd(text) + "\n";
    if (type === 13) {
      const code = block.code || data.code || {};
      const lang = code.language || "";
      let content = code.text || "";
      if (typeof content !== "string") content = textToMd(content);
      return "```" + lang + "\n" + content + "\n```\n";
    }
    if (type === 14) {
      return "> " + textToMd(text).replace(/\n/g, "\n> ") + "\n";
    }
    if (type === 15) {
      return "> 💡 " + textToMd(text).replace(/\n/g, "\n> ") + "\n";
    }
    if (type === 17) return "---\n";
    if (type === 18) {
      const image = block.image || data.image || {};
      const token = image.token;
      if (!token) return "";
      const ext = imageExt(image.mimeType);
      if (!imageSeen.has(token)) {
        imageSeen.add(token);
        images.push({ token, ext });
      }
      return "![图片](./_images/" + encodeURIComponent(token) + ext + ")\n";
    }
    if (type === 19) {
      const file = block.file || data.file || {};
      const name = file.name || "文件";
      const fileName = safeFileName(name);
      const category = grouping ? (name.startsWith("【资料】") ? "访谈嘉宾资料" : "其他资料") : "";
      const href =
        "./" +
        (category ? encodeURIComponent(category) + "/" : "") +
        encodeURIComponent(fileName);
      const label = name.replace(/([\[\]])/g, "\\$1");
      return "[📎 " + label + "](" + href + ")\n";
    }
    if (type === 22) {
      const table = block.table || data.table || {};
      const cells = table.cells || [];
      if (!Array.isArray(cells) || cells.length === 0) return "";
      const rows = cells.map((row) => {
        const list = Array.isArray(row) ? row : [];
        return list.map((cell) => {
          const ids = Array.isArray(cell) ? cell : [cell];
          let content = "";
          for (const id of ids) {
            const cellBlock = byId.get(id);
            if (cellBlock) content += blockToMd(cellBlock, allBlocks);
          }
          return content.replace(/\n+/g, " ").trim().replace(/\|/g, "\\|");
        });
      });
      const cols = Math.max.apply(
        null,
        rows.map((row) => row.length)
      );
      if (!cols) return "";
      const lines = [];
      rows.forEach((row, index) => {
        const padded = row.concat(Array(Math.max(0, cols - row.length)).fill(""));
        lines.push("| " + padded.join(" | ") + " |");
        if (index === 0) lines.push("| " + Array(cols).fill("---").join(" | ") + " |");
      });
      return lines.join("\n") + "\n";
    }
    if (type === 24) {
      const task = block.task || data.task || {};
      return "- [" + (task.done ? "x" : " ") + "] " + textToMd(text) + "\n";
    }
    if (type === 26) {
      const sheet = block.sheet || data.sheet || {};
      return "\n[📊 内嵌表格 " + (sheet.token || "") + "]\n";
    }
    if (type === 27) {
      const bitable = block.bitable || data.bitable || {};
      return "\n[📋 内嵌多维表格 " + (bitable.token || "") + "]\n";
    }
    if (type === 28) {
      const preview = block.link_preview || data.link_preview || {};
      const url = preview.url || "";
      const title = preview.title || url;
      return "[🔗 " + title + "](" + url + ")\n";
    }

    const fallback = textToMd(text);
    return fallback ? fallback + "\n" : "";
  }

  // 表格单元格的 block 也会出现在扁平列表里，先收集它们的 id，避免重复输出
  const cellIds = new Set();
  for (const block of blocks) {
    if (!block || block.block_type !== 22) continue;
    const table = block.table || (block.data && block.data.table) || {};
    const cells = table.cells || [];
    if (!Array.isArray(cells)) continue;
    for (const row of cells) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const ids = Array.isArray(cell) ? cell : [cell];
        for (const id of ids) cellIds.add(id);
      }
    }
  }

  const body = blocks
    .filter((block) => block && !cellIds.has(block.block_id))
    .map((block) => blockToMd(block, blocks))
    .join("\n");
  const markdown = body.replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, images };
}

/**
 * 将页面 SSR 的 block_map + block_sequence 渲染为 Markdown。
 * 适用于只读分享文档：这类页面没有 /space/api 权限，但 SSR 数据里一定有正文。
 * 返回 { markdown, images }，images 为去重后的 { token, ext } 列表。
 */
export function renderSsrBlocksToMarkdown(payload, options) {
  const opts = options || {};
  const grouping = opts.grouping !== false;
  const blockMap = (payload && payload.blockMap) || {};
  const sequence = Array.isArray(payload && payload.blockSequence)
    ? payload.blockSequence
    : Object.keys(blockMap);

  const images = [];
  const imageSeen = new Set();
  const cellChildIds = new Set();

  // 表格单元格的子 block 也会出现在 block_sequence 中，先记下避免顶层重复输出
  for (const id of Object.keys(blockMap)) {
    const block = blockMap[id];
    const data = block && block.data;
    if (!data || data.type !== "table") continue;
    const cellSet = data.cell_set || {};
    for (const key of Object.keys(cellSet)) {
      const cell = cellSet[key];
      if (!cell || !cell.block_id) continue;
      const cellBlock = blockMap[cell.block_id];
      const children = (cellBlock && cellBlock.data && cellBlock.data.children) || [];
      for (const childId of children) cellChildIds.add(childId);
    }
  }

  function ssrText(data) {
    const holder = data && data.text && data.text.initialAttributedTexts;
    if (!holder) return "";
    const segments = holder.text;
    if (typeof segments === "string") return segments;
    if (!segments || typeof segments !== "object") return "";
    const keys = Object.keys(segments).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    let out = "";
    for (const key of keys) {
      const value = segments[key];
      if (value != null) out += String(value);
    }
    return out;
  }

  function renderTable(data) {
    const rows = data.rows_id || [];
    const columns = data.columns_id || [];
    const cellSet = data.cell_set || {};
    if (!rows.length || !columns.length) return "";

    const grid = rows.map(function (rowId) {
      return columns.map(function (colId) {
        const cell = cellSet[rowId + colId];
        if (!cell || !cell.block_id) return "";
        const cellBlock = blockMap[cell.block_id];
        const children = (cellBlock && cellBlock.data && cellBlock.data.children) || [];
        let content = "";
        for (const childId of children) {
          const child = blockMap[childId];
          if (!child) continue;
          const piece = renderBlock(child, true);
          if (piece) content += (content ? " " : "") + piece;
        }
        return content.replace(/\n+/g, " ").trim().replace(/\|/g, "\\|");
      });
    });

    const lines = [];
    grid.forEach(function (row, index) {
      lines.push("| " + row.join(" | ") + " |");
      if (index === 0) {
        lines.push(
          "| " +
            columns
              .map(function () {
                return "---";
              })
              .join(" | ") +
            " |"
        );
      }
    });
    return lines.join("\n");
  }

  function renderBlock(block, inline) {
    if (!block || !block.data) return "";
    const data = block.data;
    if (data.hidden) return "";
    const type = data.type;
    const text = ssrText(data);

    if (type === "text") return text + (inline ? "" : "\n");
    if (/^heading[1-9]$/.test(type)) {
      const level = Math.min(6, Number(type.slice(7)));
      return "#".repeat(level) + " " + text + (inline ? "" : "\n");
    }
    if (type === "bullet") return "- " + text + (inline ? "" : "\n");
    if (type === "ordered") return "1. " + text + (inline ? "" : "\n");
    if (type === "task") {
      return "- [" + (data.done ? "x" : " ") + "] " + text + (inline ? "" : "\n");
    }
    if (type === "quote") {
      return "> " + text.replace(/\n/g, "\n> ") + (inline ? "" : "\n");
    }
    if (type === "callout") {
      return "> 💡 " + text.replace(/\n/g, "\n> ") + (inline ? "" : "\n");
    }
    if (type === "code") {
      const code = data.code || {};
      const lang = code.language || "";
      let content = ssrText(code) || text;
      if (inline) content = content.replace(/\n/g, " ");
      return inline ? content : "```" + lang + "\n" + content + "\n```\n";
    }
    if (type === "divider") return inline ? "" : "---\n";
    if (type === "image") {
      const image = data.image || {};
      const token = image.token;
      if (!token) return "";
      const ext = imageExt(image.mimeType);
      if (!imageSeen.has(token)) {
        imageSeen.add(token);
        images.push({ token, ext });
      }
      return "![图片](./_images/" + encodeURIComponent(token) + ext + ")" + (inline ? "" : "\n");
    }
    if (type === "file") {
      const file = data.file || {};
      const name = file.name || "文件";
      const fileName = safeFileName(name);
      const category = grouping ? (name.startsWith("【资料】") ? "访谈嘉宾资料" : "其他资料") : "";
      const href =
        "./" +
        (category ? encodeURIComponent(category) + "/" : "") +
        encodeURIComponent(fileName);
      const label = name.replace(/([\[\]])/g, "\\$1");
      return "[📎 " + label + "](" + href + ")" + (inline ? "" : "\n");
    }
    if (type === "table") return inline ? "" : renderTable(data) + "\n";
    if (type === "link_preview") {
      const preview = data.link_preview || {};
      const url = preview.url || "";
      const label = preview.title || url;
      return "[🔗 " + label + "](" + url + ")" + (inline ? "" : "\n");
    }
    if (type === "synced_reference") return "[🔗 同步块]";
    if (type === "page" || type === "view" || type === "table_cell") return "";
    return text ? text + (inline ? "" : "\n") : "";
  }

  const body = sequence
    .map(function (id) {
      return blockMap[id];
    })
    .filter(function (block) {
      if (!block || !block.data) return false;
      if (block.data.hidden) return false;
      if (block.data.type === "page" || block.data.type === "view" || block.data.type === "table_cell") {
        return false;
      }
      if (cellChildIds.has(block.id)) return false;
      return true;
    })
    .map(function (block) {
      return renderBlock(block, false);
    })
    .join("\n");

  const markdown = body.replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, images };
}
