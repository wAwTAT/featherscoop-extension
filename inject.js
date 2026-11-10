// inject.js — 在页面加载前接管飞书的 block 分页请求，缓存大表格等按需加载的内容
// 该文件以 MAIN world、document_start 运行，必须完全自包含。
(function () {
  const CACHE_KEY = "__featherscoopBlockCache";
  if (window[CACHE_KEY]) return;

  const cache = { byToken: {} };
  window[CACHE_KEY] = cache;

  const PATTERN = "/docx/pages/client_vars";

  function remember(url, json) {
    try {
      if (!json || json.code !== 0) return;
      const data = json.data || {};
      const map = data.block_map;
      if (!map || typeof map !== "object") return;
      let id = "";
      try {
        id = new URL(url, location.href).searchParams.get("id") || "";
      } catch (err) {
        id = "";
      }
      if (!id) return;
      let slot = cache.byToken[id];
      if (!slot) {
        slot = { blockMap: {}, blockSequence: [] };
        cache.byToken[id] = slot;
      }
      const ids = Object.keys(map);
      for (let i = 0; i < ids.length; i += 1) slot.blockMap[ids[i]] = map[ids[i]];
      const seq = Array.isArray(data.block_sequence) ? data.block_sequence : [];
      for (let i = 0; i < seq.length; i += 1) {
        if (slot.blockSequence.indexOf(seq[i]) < 0) slot.blockSequence.push(seq[i]);
      }
    } catch (err) {
      // 忽略解析失败
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : (input && input.url) || String(input || "");
      const promise = originalFetch.apply(this, arguments);
      if (url && url.indexOf(PATTERN) >= 0) {
        try {
          promise
            .then(function (res) {
              try {
                res
                  .clone()
                  .json()
                  .then(function (json) {
                    remember(url, json);
                  })
                  .catch(function () {});
              } catch (err) {
                // ignore
              }
            })
            .catch(function () {});
        } catch (err) {
          // ignore
        }
      }
      return promise;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try {
        this.__featherscoopUrl = url;
      } catch (err) {
        // ignore
      }
      return originalOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const url = this.__featherscoopUrl || "";
      if (url && String(url).indexOf(PATTERN) >= 0) {
        this.addEventListener("load", function () {
          try {
            remember(url, JSON.parse(this.responseText));
          } catch (err) {
            // ignore
          }
        });
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
