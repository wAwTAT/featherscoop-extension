// ssr.js
// 飞书 wiki 是在单页内跳转的：URL 变了，但 window.DATA 仍是首次加载时的 SSR 数据，
// 导致切换到另一篇文档后拿到的还是上一篇的正文与附件。
// 这里在页面内检测 window.DATA 是否与当前 URL 对应；不一致时重新请求当前页面 HTML，
// 解析其中内联的 clientVars（block_map）并缓存到 window.__featherscoopSsrCache。

export function refreshSsrInPage() {
  const CACHE_KEY = "__featherscoopSsrCache";
  const STALE_KEY = "__featherscoopSsrStale";
  const CACHE_TTL = 15000;

  function normalize(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function readSsr() {
    try {
      const cv = window.DATA && window.DATA.clientVars && window.DATA.clientVars.data;
      const meta = (window.DATA && window.DATA.meta) || {};
      return { cv: cv || null, meta: meta || {} };
    } catch (err) {
      return { cv: null, meta: {} };
    }
  }

  // window.DATA 是否仍对应当前 URL 的文档
  function looksCurrent() {
    const ssr = readSsr();
    const cv = ssr.cv;
    const meta = ssr.meta;
    if (!cv || !cv.block_map) return false;
    if (Object.keys(cv.block_map).length === 0) return false;

    let tokenMismatch = false;
    const path = String(location.pathname || "");
    const docx = path.match(/\/(docx|docs)\/([A-Za-z0-9]+)/);
    if (docx && meta.token) tokenMismatch = meta.token !== docx[2];

    const wiki = path.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wiki) {
      let info = null;
      try {
        info = window.current_space_wiki;
      } catch (err) {
        info = null;
      }
      if (info) {
        if (info.wiki_token && info.wiki_token !== wiki[1]) tokenMismatch = true;
        if (!tokenMismatch && info.obj_token && meta.token && info.obj_token !== meta.token) {
          tokenMismatch = true;
        }
      }
    }

    // 单页跳转后 document.title 会先更新，而 meta.title 保持首次加载的标题
    const docTitle = normalize(document.title);
    const metaTitle = normalize(meta.title);
    const sample = metaTitle.slice(0, 20);
    const titleChanged = sample !== "" && docTitle !== "" && docTitle.indexOf(sample) < 0;

    return !(tokenMismatch || titleChanged);
  }

  function balancedSlice(text, openIndex) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = openIndex; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = "";
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return text.slice(openIndex, i + 1);
      }
    }
    return "";
  }

  function parseObjectAt(html, objectAt) {
    const open = html.indexOf("(", objectAt);
    if (open < 0) return null;
    const literal = balancedSlice(html, open);
    if (!literal) return null;
    try {
      return JSON.parse(literal.slice(1, -1));
    } catch (err) {
      return null;
    }
  }

  // 解析 window.DATA = Object.assign({}, window.DATA, { clientVars: Object({...}) })
  function extractClientVars(html) {
    let from = 0;
    while (true) {
      const at = html.indexOf("clientVars", from);
      if (at < 0) return null;
      from = at + 10;
      const objectAt = html.indexOf("Object(", at);
      if (objectAt < 0) return null;
      if (objectAt - at > 60) continue;
      const parsed = parseObjectAt(html, objectAt);
      if (!parsed || !parsed.data || !parsed.data.block_map) continue;
      if (Object.keys(parsed.data.block_map).length === 0) continue;
      return parsed;
    }
  }

  // 解析 window.DATA = { clientVars: undefined, meta: Object({...}) } 中的 meta
  function extractMeta(html) {
    const at = html.search(/window\.DATA\s*=\s*\{[\s\S]{0,400}?\bmeta\s*:\s*Object\(/);
    if (at < 0) return null;
    const objectAt = html.indexOf("Object(", at);
    if (objectAt < 0) return null;
    const parsed = parseObjectAt(html, objectAt);
    if (!parsed || (!parsed.token && !parsed.title)) return null;
    return parsed;
  }

  async function fetchHtml(url) {
    let controller = null;
    try {
      controller = new AbortController();
    } catch (err) {
      controller = null;
    }
    const timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 20000);
    try {
      const res = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  return (async function () {
    const current = String(location.href || "");
    let cache = null;
    try {
      cache = window[CACHE_KEY];
    } catch (err) {
      cache = null;
    }
    if (cache && cache.url === current && Date.now() - cache.ts < CACHE_TTL) {
      return { ok: true, stale: false, cached: true, title: cache.title };
    }

    if (looksCurrent()) {
      return { ok: true, stale: false, cached: false };
    }

    try {
      const html = await fetchHtml(current);
      const clientVars = extractClientVars(html);
      if (!clientVars) throw new Error("未能从页面数据中解析出当前文档的正文");
      const meta = extractMeta(html) || {};
      const keys = Object.keys(clientVars.data.block_map);
      if (keys.length === 0) throw new Error("当前文档正文为空");

      const fresh = {
        url: current,
        title: String(meta.title || ""),
        meta: meta,
        blockMap: clientVars.data.block_map,
        blockSequence: Array.isArray(clientVars.data.block_sequence)
          ? clientVars.data.block_sequence
          : keys,
        ts: Date.now(),
      };
      try {
        window[CACHE_KEY] = fresh;
        window[STALE_KEY] = false;
      } catch (err) {
        // 页面禁止写入时忽略
      }
      return { ok: true, stale: true, refreshed: true, title: fresh.title };
    } catch (err) {
      try {
        window[STALE_KEY] = true;
      } catch (e) {
        // ignore
      }
      return {
        ok: false,
        stale: true,
        error: String(err && err.message ? err.message : err),
      };
    }
  })();
}
