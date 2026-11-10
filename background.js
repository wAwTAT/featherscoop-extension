// background.js — 在浏览器启动/安装时注册 inject.js，让它在页面加载前接管分页请求
// manifest 的 content_scripts.world 需要 Chrome 111+，这里改用 scripting.registerContentScripts，
// 兼容 Chrome/Edge 102+。

const SCRIPT_ID = "featherscoop-inject";
const MATCHES = [
  "*://*.feishu.cn/*",
  "*://*.larksuite.com/*",
  "*://*.larkoffice.com/*",
];

async function ensureInjectScript() {
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
    // 旧版本不支持 world 参数时，退化为隔离环境注入（不影响其他功能）
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          matches: MATCHES,
          js: ["inject.js"],
          runAt: "document_start",
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    } catch (inner) {
      // ignore
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureInjectScript();
});
chrome.runtime.onStartup.addListener(() => {
  ensureInjectScript();
});
ensureInjectScript();
