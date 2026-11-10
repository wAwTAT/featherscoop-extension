// doc_export.js — 飞书 docx 正文导出：页面内拉取 block 数据，弹窗内渲染 Markdown

import { safeFileName } from "./shared.js";

/** 去掉飞书编辑器的零宽占位字符 */
function stripZeroWidth(input) {
  return String(input == null ? "" : input).replace(/[\u200b\u200c\u200d\ufeff]/g, "");
}

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
        if (!token) return { cached: 0, paged: 0, api: "no-token" };

        const startCursors = Array.isArray(sourceCv && sourceCv.next_cursors)
          ? sourceCv.next_cursors.slice(0, 40)
          : [];
        // 所有模式共享请求预算，避免大文档拖慢导出
        let budget = 30;
        let cachedAdded = 0;
        let apiState = "none";
        let apiMsg = "";

        // 页面自己加载过的分页数据（由 inject.js 在 MAIN world 拦截并缓存）
        try {
          const cache = window.__featherscoopBlockCache;
          const slot = cache && cache.byToken && cache.byToken[token];
          if (slot && slot.blockMap) {
            const cached = Object.keys(slot.blockMap);
            for (let i = 0; i < cached.length; i += 1) {
              const id = cached[i];
              if (!map[id]) {
                map[id] = slot.blockMap[id];
                cachedAdded += 1;
              }
            }
            const cachedSeq = slot.blockSequence || [];
            for (let i = 0; i < cachedSeq.length; i += 1) {
              if (seq.indexOf(cachedSeq[i]) < 0) seq.push(cachedSeq[i]);
            }
          }
        } catch (err) {
          // 没有缓存时忽略
        }

        // 复刻页面请求头，避免接口因缺少请求标识而拒绝
        function apiHeaders() {
          const headers = { Accept: "application/json, text/plain, */*" };
          try {
            const matched = String(document.cookie || "").match(/(?:^|;\s*)swp_csrf_token=([^;]*)/);
            if (matched && matched[1]) headers["x-csrf-token"] = decodeURIComponent(matched[1]);
          } catch (err) {
            // ignore
          }
          const rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          headers["Request-Id"] = rid;
          headers["X-Request-Id"] = rid;
          headers["X-TT-LOGID"] = "0" + rid;
          return headers;
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
                headers: apiHeaders(),
              });
              if (!res.ok) {
                apiState = apiState === "none" ? "http-" + res.status : apiState;
                return added;
              }
              json = await res.json();
            } catch (err) {
              apiState = apiState === "none" ? "network" : apiState;
              return added;
            }
            if (!json || json.code !== 0) {
              apiState = apiState === "none" ? "code-" + (json ? json.code : "bad") : apiState;
              if (!apiMsg && json && json.msg) apiMsg = String(json.msg);
              return added;
            }
            if (apiState === "none") apiState = "ok";
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

        // 读取页面实际请求过的文档数据地址（含真实参数），按原样重放
        function collectPageUrls() {
          const out = [];
          const seen = {};
          try {
            const entries = performance.getEntriesByType("resource") || [];
            for (let i = 0; i < entries.length; i += 1) {
              const name = String((entries[i] && entries[i].name) || "");
              if (!name) continue;
              if (name.indexOf("/docx/") < 0 && name.indexOf("/api/docx") < 0) continue;
              if (!/client_vars|blocks|block_list|content/.test(name)) continue;
              if (seen[name]) continue;
              seen[name] = 1;
              out.push(name);
              if (out.length >= 40) break;
            }
          } catch (err) {
            // ignore
          }
          return out;
        }

        async function fetchMerge(url) {
          budget -= 1;
          let json = null;
          try {
            const res = await fetch(url, {
              credentials: "include",
              headers: apiHeaders(),
            });
            if (!res.ok) {
              apiState = apiState === "none" ? "http-" + res.status : apiState;
              return { added: 0, data: null };
            }
            json = await res.json();
          } catch (err) {
            apiState = apiState === "none" ? "network" : apiState;
            return { added: 0, data: null };
          }
          if (!json || json.code !== 0) {
            apiState = apiState === "none" ? "code-" + (json ? json.code : "bad") : apiState;
            if (!apiMsg && json && json.msg) apiMsg = String(json.msg);
            return { added: 0, data: null };
          }
          if (apiState === "none") apiState = "ok";
          const data = json.data || {};
          const more = data.block_map || {};
          let added = 0;
          const ids = Object.keys(more);
          for (let i = 0; i < ids.length; i += 1) {
            const id = ids[i];
            if (!map[id]) {
              map[id] = more[id];
              added += 1;
            }
          }
          const moreSeq = Array.isArray(data.block_sequence) ? data.block_sequence : [];
          for (let i = 0; i < moreSeq.length; i += 1) {
            if (seq.indexOf(moreSeq[i]) < 0) seq.push(moreSeq[i]);
          }
          return { added: added, data: data };
        }

        const pageUrls = collectPageUrls();
        let paged = 0;
        let replayed = 0;
        let template = "";
        let cursors = [];

        for (let i = 0; i < pageUrls.length && budget > 0; i += 1) {
          const result = await fetchMerge(pageUrls[i]);
          replayed += 1;
          template = pageUrls[i];
          paged += result.added;
          const data = result.data || {};
          const next = Array.isArray(data.next_cursors) ? data.next_cursors : [];
          cursors = cursors.concat(next);
          if (data.has_more && data.cursor) cursors.push(data.cursor);
        }

        // 用页面自己的地址作为模板继续翻页，避免猜错参数
        if (template) {
          const seenCursor = {};
          let tries = 0;
          while (cursors.length && budget > 0 && tries < 30) {
            const cursor = cursors.shift();
            if (!cursor || seenCursor[cursor]) continue;
            seenCursor[cursor] = 1;
            tries += 1;
            let url = "";
            try {
              const u = new URL(template, location.href);
              u.searchParams.set("cursor", cursor);
              url = u.href;
            } catch (err) {
              break;
            }
            const result = await fetchMerge(url);
            paged += result.added;
            const data = result.data || {};
            const next = Array.isArray(data.next_cursors) ? data.next_cursors : [];
            cursors = cursors.concat(next);
            if (data.has_more && data.cursor) cursors.push(data.cursor);
          }
        }

        // 同步块里的内容（大表格常放在同步块）用 mode=4 单独拉取
        function collectSyncedTargets() {
          const out = [];
          const ids = Object.keys(map);
          for (let i = 0; i < ids.length; i += 1) {
            const data = (map[ids[i]] && map[ids[i]].data) || {};
            if (data.type !== "synced_reference") continue;
            if (data.src_page_id && data.src_block_id) {
              out.push({ page: data.src_page_id, block: data.src_block_id });
            }
          }
          return out;
        }

        function syncedUrl(target) {
          let url =
            "/space/api/docx/pages/client_vars?id=" +
            encodeURIComponent(target.page) +
            "&mode=4&limit=239&block_id=" +
            encodeURIComponent(target.block);
          try {
            const space = window.current_space_wiki || {};
            if (space.space_id) url += "&wiki_space_id=" + encodeURIComponent(space.space_id);
          } catch (err) {
            // ignore
          }
          try {
            const matched = String(location.pathname || "").match(/\/wiki\/([A-Za-z0-9]+)/);
            if (matched) {
              url += "&container_type=wiki2.0&container_id=" + encodeURIComponent(matched[1]);
            }
          } catch (err) {
            // ignore
          }
          return url;
        }

        // 页面没有可用请求记录时，退回按已知模式尝试
        const syncedTargets = collectSyncedTargets();
        let synced = 0;
        for (let i = 0; i < syncedTargets.length && budget > 0; i += 1) {
          const result = await fetchMerge(syncedUrl(syncedTargets[i]));
          synced += 1;
          paged += result.added;
        }

        if (paged === 0) {
          paged += await pull("table_skip_block", startCursors);
          paged += await pull("normal_block", startCursors);
          if (paged === 0) paged += await pull("table_skip_block", []);
          paged += await pull("foldable_skip_block", []);
        }

        return {
          cached: cachedAdded,
          paged: paged,
          replayed: replayed,
          synced: synced,
          api: apiState,
          apiMsg: apiMsg,
          pageUrls: pageUrls.slice(0, 3),
        };
      }

      // 飞书编辑器用零宽空格占位，导出前清掉
      function cleanCellText(input) {
        return String(input == null ? "" : input)
          .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      }

      // 读取单元格文本；block 或文字缺失都算不完整
      function cellTextOf(map, cellId) {
        const cell = map[cellId];
        const children = (cell && cell.data && cell.data.children) || [];
        let out = "";
        for (let i = 0; i < children.length; i += 1) {
          const block = map[children[i]];
          const data = (block && block.data) || {};
          if (typeof data.text === "string") {
            out += data.text;
            continue;
          }
          const holder = data.text && data.text.initialAttributedTexts;
          if (!holder || !holder.text) continue;
          const segments = holder.text;
          if (typeof segments === "string") {
            out += segments;
          } else if (segments && typeof segments === "object") {
            const keys = Object.keys(segments);
            for (let k = 0; k < keys.length; k += 1) {
              const value = segments[keys[k]];
              if (value != null) out += String(value);
            }
          }
        }
        return cleanCellText(out);
      }

      // 统计表格单元格的结构完整性：单元格 block 或它的子块缺失才算不完整
      // （真正空白的单元格不算，避免误报）
      function tableStats(map, overrides) {
        const ov = overrides || {};
        let tables = 0;
        let cells = 0;
        let incomplete = 0;
        const ids = Object.keys(map);
        for (let i = 0; i < ids.length; i += 1) {
          const data = (map[ids[i]] && map[ids[i]].data) || {};
          if (data.type !== "table") continue;
          tables += 1;
          const cellSet = data.cell_set || {};
          const keys = Object.keys(cellSet);
          for (let j = 0; j < keys.length; j += 1) {
            const cell = cellSet[keys[j]];
            if (!cell || !cell.block_id) continue;
            cells += 1;
            if (ov[cell.block_id]) continue;
            const cellBlock = map[cell.block_id];
            if (!cellBlock) {
              incomplete += 1;
              continue;
            }
            const children = (cellBlock.data && cellBlock.data.children) || [];
            for (let k = 0; k < children.length; k += 1) {
              if (!map[children[k]]) {
                incomplete += 1;
                break;
              }
            }
          }
        }
        return { tables: tables, cells: cells, incomplete: incomplete };
      }

      // 大表格往往只渲染可视区域，滚动一遍把单元格文字收齐
      async function collectDomTables() {
        const sleep = function (ms) {
          return new Promise(function (resolve) {
            setTimeout(resolve, ms);
          });
        };

        const nodes = [];
        try {
          const list = document.querySelectorAll("table");
          for (let i = 0; i < list.length; i += 1) nodes.push({ el: list[i], rows: [] });
        } catch (err) {
          return [];
        }
        if (!nodes.length) return [];

        function snapshot() {
          for (let i = 0; i < nodes.length; i += 1) {
            const node = nodes[i];
            let trs = [];
            try {
              trs = node.el.querySelectorAll("tr");
            } catch (err) {
              trs = [];
            }
            if (!node.rows.length) {
              for (let r = 0; r < trs.length; r += 1) node.rows.push([]);
            }
            for (let r = 0; r < trs.length && r < node.rows.length; r += 1) {
              const tds = trs[r].querySelectorAll("td,th");
              for (let c = 0; c < tds.length; c += 1) {
                const text = cleanCellText(tds[c].innerText);
                if (!text) continue;
                if (!node.rows[r][c]) node.rows[r][c] = text;
              }
            }
          }
        }

        snapshot();

        let scroller = null;
        try {
          let cur = nodes[0].el.parentElement;
          while (cur && cur !== document.body) {
            const style = window.getComputedStyle(cur);
            const overflow = style ? style.overflowY : "";
            if (
              cur.scrollHeight > cur.clientHeight + 40 &&
              (overflow === "auto" || overflow === "scroll" || overflow === "overlay")
            ) {
              scroller = cur;
              break;
            }
            cur = cur.parentElement;
          }
        } catch (err) {
          scroller = null;
        }
        if (!scroller) scroller = document.scrollingElement || document.documentElement;

        const saved = scroller.scrollTop;
        let steps = 0;
        try {
          const step = Math.max(240, Math.floor((scroller.clientHeight || 600) * 0.8));
          const max = scroller.scrollHeight || 0;
          for (let y = 0; y <= max && steps < 40; y += step) {
            scroller.scrollTop = y;
            steps += 1;
            await sleep(120);
            snapshot();
          }
          scroller.scrollTop = saved;
        } catch (err) {
          try {
            scroller.scrollTop = saved;
          } catch (inner) {
            // ignore
          }
        }

        // 不要过滤空行，保持行号与表格 rows_id 一一对应
        return nodes.map(function (node) {
          return node.rows;
        });
      }

      // 最后兜底：分页数据既没取到也没拦截到时，从页面已渲染的表格 DOM 补全
      async function fillFromDom(map, overrides) {
        const domTables = await collectDomTables();
        if (!domTables.length) return 0;

        const used = {};
        let filled = 0;
        const ids = Object.keys(map);
        for (let i = 0; i < ids.length; i += 1) {
          const tableBlock = map[ids[i]];
          const data = (tableBlock && tableBlock.data) || {};
          if (data.type !== "table") continue;
          const rows = data.rows_id || [];
          const cols = data.columns_id || [];
          if (!rows.length || !cols.length) continue;

          let pick = -1;
          for (let t = 0; t < domTables.length; t += 1) {
            if (used[t]) continue;
            if (domTables[t].length === rows.length && domTables[t][0].length === cols.length) {
              pick = t;
              break;
            }
          }
          // 有些单元格被合并或首行为空，退一步按行数匹配
          if (pick < 0) {
            for (let t = 0; t < domTables.length; t += 1) {
              if (used[t]) continue;
              if (domTables[t].length === rows.length) {
                pick = t;
                break;
              }
            }
          }
          if (pick < 0) continue;
          used[pick] = 1;

          const dom = domTables[pick];
          const cellSet = data.cell_set || {};
          for (let r = 0; r < rows.length && r < dom.length; r += 1) {
            for (let c = 0; c < cols.length && c < dom[r].length; c += 1) {
              const cell = cellSet[rows[r] + cols[c]];
              if (!cell || !cell.block_id) continue;
              if (cellTextOf(map, cell.block_id) || overrides[cell.block_id]) continue;
              const text = dom[r][c];
              if (!text) continue;
              overrides[cell.block_id] = text;
              filled += 1;
            }
          }
        }
        return filled;
      }

      // 收集拦截器状态，便于排查取数失败的原因
      function withCacheDiag(diag) {
        const out = diag || {};
        try {
          const cache = window.__featherscoopBlockCache;
          out.injected = Boolean(cache && cache.injectedAt);
          out.urls = cache && Array.isArray(cache.urls) ? cache.urls.slice(0, 5) : [];
        } catch (err) {
          out.injected = false;
          out.urls = [];
        }
        return out;
      }

      // 统一补全流程：分页数据 → DOM，返回 { incomplete, diag, overrides }
      async function completeBlocks(map, seq, sourceCv) {
        const overrides = {};
        let diag = null;
        let stats = tableStats(map, overrides);
        const needMore = Boolean(sourceCv && sourceCv.has_more) || stats.incomplete > 0;
        if (needMore) {
          try {
            diag = await fillRemaining(sourceCv, map, seq);
          } catch (err) {
            diag = { cached: 0, paged: 0, api: "error" };
          }
          stats = tableStats(map, overrides);
          const domFilled = await fillFromDom(map, overrides);
          if (diag) diag.dom = domFilled;
          stats = tableStats(map, overrides);
        }
        if (diag) diag.stats = stats;
        return { incomplete: stats.incomplete, diag: diag, overrides: overrides };
      }

      if (fresh) {
        const map = fresh.blockMap;
        const seq = fresh.blockSequence || Object.keys(map);
        const done = await completeBlocks(map, seq, {
          has_more: fresh.hasMore,
          next_cursors: fresh.nextCursors || [],
          obj_token: fresh.objToken || "",
        });
        write({
          status: "done",
          source: "ssr",
          title: fresh.title || title,
          blockMap: map,
          blockSequence: seq,
          overrides: done.overrides,
          incomplete: done.incomplete,
          diag: withCacheDiag(done.diag),
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
          const done = await completeBlocks(map, seq, cvData);
          write({
            status: "done",
            source: "ssr",
            title: title,
            blockMap: map,
            blockSequence: seq,
            overrides: done.overrides,
            incomplete: done.incomplete,
            diag: withCacheDiag(done.diag),
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
  const overrides = (payload && payload.overrides) || {};
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
    if (typeof segments === "string") return stripZeroWidth(segments);
    if (!segments || typeof segments !== "object") return "";
    const keys = Object.keys(segments).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    let out = "";
    for (const key of keys) {
      const value = segments[key];
      if (value != null) out += String(value);
    }
    return stripZeroWidth(out);
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
        if (!content && overrides[cell.block_id]) content = overrides[cell.block_id];
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
