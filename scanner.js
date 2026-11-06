// scanner.js
// scanInPage 会被 chrome.scripting.executeScript 以 MAIN world 方式注入页面执行，
// 用来读取飞书文档 SSR 注入的 window.DATA。
// 注意：该函数体必须完全自包含，不能引用模块作用域中的任何变量，
// 否则序列化后注入时会因找不到变量而失败。

export function scanInPage(rootOverride) {
  const win = rootOverride || (typeof window !== "undefined" ? window : globalThis);
  const MAX_DEPTH = 7;
  const blockMaps = [];
  const seen = new Set();

  function walk(start) {
    const stack = [{ value: start, depth: 0 }];
    while (stack.length) {
      const job = stack.pop();
      const value = job.value;
      const depth = job.depth;
      if (!value || typeof value !== "object" || depth > MAX_DEPTH || seen.has(value)) continue;
      seen.add(value);

      let keys = [];
      try {
        keys = Object.keys(value);
      } catch (err) {
        continue;
      }

      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (key === "block_map" || key === "blockMap") {
          let bm = null;
          try {
            bm = value[key];
          } catch (err) {
            bm = null;
          }
          if (bm && typeof bm === "object") blockMaps.push(bm);
          continue;
        }
        if (depth >= MAX_DEPTH) continue;
        let child = null;
        try {
          child = value[key];
        } catch (err) {
          child = null;
        }
        if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      }
    }
  }

  const roots = [];
  if (rootOverride) {
    roots.push(rootOverride);
  } else {
    const candidates = ["DATA", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__SSR_DATA__", "SSR_DATA"];
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const candidate = win[candidates[i]];
        if (candidate && typeof candidate === "object") roots.push(candidate);
      } catch (err) {
        // 跨域属性或 getter 抛错时忽略
      }
    }
    try {
      if (win.DATA && win.DATA.clientVars) roots.push(win.DATA.clientVars);
    } catch (err) {
      // ignore
    }
  }
  for (const root of roots) walk(root);

  const files = [];
  const tokens = new Set();

  function addFile(info) {
    if (!info || typeof info !== "object") return;
    const token = info.token || info.file_token || info.fileToken || info.file_key;
    if (!token || tokens.has(token)) return;
    const name = info.name || info.file_name || info.fileName || info.title || "";
    let size = info.size;
    if (size === undefined) size = info.file_size;
    if (size === undefined) size = info.fileSize;
    if (size === undefined) size = 0;
    if (typeof size !== "number") size = parseInt(size, 10);
    if (!isFinite(size) || size < 0) size = 0;
    tokens.add(token);
    files.push({ token: String(token), name: String(name || token), size: size });
  }

  function isFileType(type, block) {
    return (
      type === "file" ||
      type === "attachment" ||
      type === "attach" ||
      type === 19 ||
      (block && (block.block_type === 19 || block.type === 19))
    );
  }

  for (const bm of blockMaps) {
    let keys = [];
    try {
      keys = Object.keys(bm);
    } catch (err) {
      continue;
    }
    for (let i = 0; i < keys.length; i += 1) {
      const block = bm[keys[i]];
      if (!block || typeof block !== "object") continue;
      const data = block.data && typeof block.data === "object" ? block.data : {};
      const type = data.type !== undefined ? data.type : block.type !== undefined ? block.type : block.block_type;

      // 文件块的标准结构：block.data.file = { token, name, size }
      const direct = data.file || block.file;
      if (direct && typeof direct === "object") {
        addFile(direct);
        continue;
      }
      const alt = data.file_info || data.fileInfo || block.file_info;
      if (alt && typeof alt === "object" && isFileType(type, block)) addFile(alt);
    }
  }

  files.sort(function (a, b) {
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });

  let pageTitle = "";
  let pageUrl = "";
  let docTitle = "";
  try {
    pageTitle = (win.document && win.document.title) || "";
  } catch (err) {
    pageTitle = "";
  }
  try {
    pageUrl = (win.location && win.location.href) || "";
  } catch (err) {
    pageUrl = "";
  }
  try {
    if (win.DATA && win.DATA.clientVars && win.DATA.clientVars.data) {
      docTitle = win.DATA.clientVars.data.title || "";
    }
  } catch (err) {
    docTitle = "";
  }

  return { pageTitle: pageTitle, pageUrl: pageUrl, docTitle: docTitle, files: files };
}
