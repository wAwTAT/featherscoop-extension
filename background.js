// background.js — 在页面加载早期把分页拦截器注入 MAIN world
// manifest 的 content_scripts.world 需要 Chrome 111+，这里使用
// webNavigation.onCommitted + scripting.executeScript（Chrome 102+ 即可）。

const SCRIPT_ID = "featherscoop-inject";
const MATCHES = [
  "*://*.feishu.cn/*",
  "*://*.larksuite.com/*",
  "*://*.larkoffice.com/*",
];

function isFeishuUrl(url) {
  const text = String(url || "");
  return (
    text.indexOf("feishu.cn") >= 0 ||
    text.indexOf("larksuite.com") >= 0 ||
    text.indexOf("larkoffice.com") >= 0
  );
}

/**
 * 注入到页面 MAIN world，接管飞书自己的分页请求并缓存响应。
 * 该函数会被序列化注入，必须完全自包含。
 */
function installBlockHook() {
  const CACHE_KEY = "__featherscoopBlockCache";
  if (window[CACHE_KEY]) return;

  const cache = { byToken: {}, urls: [], injectedAt: Date.now() };
  window[CACHE_KEY] = cache;

  const PATTERN = "/docx/pages/client_vars";

  function logUrl(url) {
    try {
      if (!url || cache.urls.length >= 40) return;
      if (String(url).indexOf("client_vars") < 0) return;
      if (cache.urls.indexOf(String(url)) < 0) cache.urls.push(String(url));
    } catch (err) {
      // ignore
    }
  }

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
      // ignore
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : (input && input.url) || String(input || "");
      logUrl(url);
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
        logUrl(url);
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
}

function injectInto(tabId, frameId) {
  try {
    chrome.scripting
      .executeScript({
        target: { tabId: tabId, frameIds: [typeof frameId === "number" ? frameId : 0] },
        world: "MAIN",
        func: installBlockHook,
      })
      .catch(() => {});
  } catch (err) {
    // ignore
  }
}

async function ensureRegister() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (err) {
    // 未注册过时忽略
  }
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches: MATCHES,
        js: ["inject.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  } catch (err) {
    // 旧版本不支持 world 时，改由 onCommitted 注入
  }
}

if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener(function (details) {
    if (!details || details.frameId !== 0) return;
    if (!isFeishuUrl(details.url)) return;
    injectInto(details.tabId, 0);
  });
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (!changeInfo || changeInfo.status !== "loading") return;
  const url = (tab && tab.url) || "";
  if (!isFeishuUrl(url)) return;
  injectInto(tabId, 0);
});

chrome.runtime.onInstalled.addListener(function () {
  ensureRegister();
});
chrome.runtime.onStartup.addListener(function () {
  ensureRegister();
});
ensureRegister();
