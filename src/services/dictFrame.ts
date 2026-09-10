/**
 * 词条 iframe 沙箱帧组装（自 src/windows/DictionaryTab.tsx 抽出 复习页复用）。
 * 引导脚本：点击委托（entry:// 重查 / sound:// 播放回传）+ 高度上报。
 * 复习页只监听高度消息、不监听 entry:// → 词条内链不跟随（pickdict ReviewPage 语义）。
 */

/** 注入 srcdoc 的引导脚本：点击委托 + 高度上报（iframe 高度自适应） */
export const BOOT_SCRIPT = `
<script>
(function () {
  var post = function (msg) { try { parent.postMessage(msg, '*'); } catch (e) {} };
  // 右键屏蔽（桌面应用形态）：词条帧不弹 WebView2 网页菜单；复制走 Ctrl+C，
  // 帧内取词/拖选词组均为左键语义不受影响
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // 页内锚点：id/name 原样 → percent 解码兜底（pickdict #21；zdic 的 id 与 href fragment
  // 同为 hex 编码形态，原样即中；O8C 义项导航 entry://#take_pos_v 同走此路径）
  var scrollToFragment = function (frag) {
    if (!frag) return;
    var find = function (id) {
      return document.getElementById(id) || document.getElementsByName(id)[0] || null;
    };
    var el = find(frag);
    if (!el) {
      try { el = find(decodeURIComponent(frag)); } catch (err) {}
    }
    if (el) el.scrollIntoView();
  };
  // ── 帧内取词（词条内词索引）：click 委托 +
  // caretRangeFromPoint（WebView2=Chromium）。点击非交互目标时按坐标定位文本节点
  // 与偏移，按词边界扩展（拉丁字母/数字/连字符/撇号连续段；CJK 逐字）→
  // onedict-word 回传父页面走 entry:// 同路径重查。零 DOM 改写零样式破坏；
  // 交互目标豁免（发音/折叠栏头/表单控件）防误触。
  var isLatin = function (ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === "'";
  };
  var isCJK = function (ch) {
    var c = ch.codePointAt(0);
    return (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff);
  };
  var caretRangeAt = function (x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      try {
        var r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      } catch (err) { return null; }
    }
    return null;
  };
  var pickWordAt = function (x, y) {
    var r = caretRangeAt(x, y);
    // startContainer 须为文本节点（落点在元素空白/内边距时是元素节点 → 放弃）
    if (!r || !r.startContainer || r.startContainer.nodeType !== 3) return null;
    var text = r.startContainer.data;
    var pos = Math.min(r.startOffset, text.length - 1);
    if (pos < 0) return null;
    var ch = text[pos];
    if (!isLatin(ch) && !isCJK(ch)) {
      // 点在空白/标点上：借右侧邻位，再借左侧，仍无效则放弃（点空白不查词）
      if (pos + 1 < text.length && isLatin(text[pos + 1])) pos += 1;
      else if (pos > 0 && isLatin(text[pos - 1])) pos -= 1;
      else return null;
      ch = text[pos];
    }
    if (isCJK(ch)) return ch; // CJK 逐字（词典软件惯例，单字多 MISS 可接受）
    var lo = pos;
    var hi = pos;
    while (lo > 0 && isLatin(text[lo - 1])) lo -= 1;
    while (hi + 1 < text.length && isLatin(text[hi + 1])) hi += 1;
    // 首尾连字符/撇号不属词本体（'-hello-' → hello）
    return text.slice(lo, hi + 1).replace(/^[-']+|[-']+$/g, '') || null;
  };
  var INTERACTIVE_SEL = 'a,button,input,select,textarea,img,svg,video,audio,[role]';
  // ── 拖选词组查询：mouseup 后选区非折叠 → 规整文本（空白折叠、
  // 2–60 字）→ 延迟 400ms 跳词组查询（走 onedict-word 同管道，父层入导航栈）。
  // 延迟窗口内选区变化/再次按下 → 取消，保护「拖选只为复制」场景。与单击查字
  // 天然互斥（拖选结束不产生 click；双击选词走本路径 = 查整词）。
  var pickPhrase = function () {
    var sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || text.length > 60) return null;
    return text;
  };
  var phraseTimer = null;
  var cancelPhrase = function () {
    if (phraseTimer) {
      clearTimeout(phraseTimer);
      phraseTimer = null;
    }
  };
  document.addEventListener('mouseup', function (e) {
    if (e.button !== 0) return;
    cancelPhrase(); // 上一次未触发的拖选意图作废
    var phrase = pickPhrase();
    if (!phrase) return;
    phraseTimer = setTimeout(function () {
      phraseTimer = null;
      // 延迟期间选区被折叠/改动 → 放弃（still 比对同一文本）
      var still = pickPhrase();
      if (still && still === phrase) {
        post({ type: 'onedict-word', word: phrase, via: 'select' });
      }
    }, 400);
  }, true);
  document.addEventListener('selectionchange', cancelPhrase);
  var pickOnClick = function (e) {
    if (e.button !== 0 || e.detail > 1) return; // 仅左键单击；双击留给原生选词
    // 选区非折叠 = 拖选/双击选词刚结束——**同元素内拖选 click 照常派发**（仅跨元素
    // 拖选才无 click），若不守卫，同步单字查询会先跳并重渲染，400ms 词组检查落空，
    // 表现为「拖选仍是单击效果」。让位给 mouseup 词组路径。
    var sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    var t = e.target;
    if (!t || !t.closest || t.closest(INTERACTIVE_SEL)) return;
    var w = pickWordAt(e.clientX, e.clientY);
    if (w) post({ type: 'onedict-word', word: w });
  };
  // 悬停光标反馈（降低误触风险）：mousemove 委托按坐标取词判定——能取到词才
  // pointer，与点击判定完全同口径；交互元素自带 cursor 不覆盖。2px 位移节流
  // 避免高频 hit-test；拖选中/鼠标离开帧恢复默认。
  var lastHoverX = -1;
  var lastHoverY = -1;
  var resetHoverCursor = function () {
    lastHoverX = -1;
    lastHoverY = -1;
    document.body.style.cursor = '';
  };
  document.addEventListener('mousemove', function (e) {
    if (e.buttons) {
      resetHoverCursor(); // 拖选进行中不提示可点
      return;
    }
    var dx = e.clientX - lastHoverX;
    var dy = e.clientY - lastHoverY;
    if (lastHoverX >= 0 && dx > -2 && dx < 2 && dy > -2 && dy < 2) return;
    lastHoverX = e.clientX;
    lastHoverY = e.clientY;
    var t = e.target;
    var onWord = false;
    if (t && t.closest && !t.closest(INTERACTIVE_SEL)) {
      onWord = !!pickWordAt(e.clientX, e.clientY);
    }
    document.body.style.cursor = onWord ? 'pointer' : '';
  }, true);
  document.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget) resetHoverCursor(); // 鼠标离开 iframe
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a') : null;
    if (!a) {
      pickOnClick(e); // 非链接：交互目标豁免，其余按坐标取词
      return;
    }
    var href = a.getAttribute('href') || '';
    if (href.indexOf('entry://') === 0) {
      e.preventDefault();
      var rest = href.slice(8);
      var hashIdx = rest.indexOf('#');
      var word = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
      var frag = hashIdx >= 0 ? rest.slice(hashIdx + 1) : null;
      if (!word) {
        scrollToFragment(frag); // entry://#frag = 同词条页内锚点，不重查
        return;
      }
      try { word = decodeURIComponent(word); } catch (err) {}
      word = word.replace(/\\/+$/, ''); // pickdict #21：目录式跨词条链接尾斜杠必 MISS
      post({ type: 'onedict-entry', word: word });
    } else if (href.indexOf('sound://') === 0) {
      e.preventDefault();
      post({ type: 'onedict-sound', key: href.slice(8) });
    } else if (href.indexOf('webaudio://') === 0) {
      // 在线词典发音锚点（URL percent 编码存放）：委托父页面 webdict_audio 下载
      e.preventDefault();
      var audioUrl = href.slice(11);
      try { audioUrl = decodeURIComponent(audioUrl); } catch (err) {}
      post({ type: 'onedict-webaudio', url: audioUrl });
    } else if (href.indexOf('http') === 0 || href.indexOf('javascript:') === 0) {
      e.preventDefault();
      // 在线源帧允许 http(s) 外链委托出去（父页按偏好分流：浏览器 / 转内部查词；
      // text = 链接文本，供内部查词模式提取词）；本地词条帧保持死链语义
      if (href.indexOf('http') === 0 && window.ONEDICT_ALLOW_EXTERNAL === true) {
        post({
          type: 'onedict-external',
          url: href,
          text: ((a.textContent || '').trim() || '').slice(0, 80),
        });
      }
    }
    // href="#..." 页内锚点放行
  }, true);
  // 主窗口解码完成回传 → 播放（用户点击手势链路内；被 autoplay 拦截时上报错误）
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'onedict-sound-data' && d.base64) {
      try {
        var audio = new Audio('data:' + d.mime + ';base64,' + d.base64);
        audio.play().catch(function () {
          post({ type: 'onedict-sound-error', msg: '浏览器阻止了自动播放，请再点一次发音按钮' });
        });
      } catch (err) {
        post({ type: 'onedict-sound-error', msg: String(err) });
      }
    }
  });
  // 高度上报携带查询轮次 token（buildSrcdoc 注入）：跳词瞬间旧文档因 iframe 视口
  // resize 触发的残留上报会被父页面按 token 丢弃——否则 documentElement.scrollHeight
  // = max(内容高, 视口高) 的自反馈会把 iframe 高度锁死在历史最大值（实测跳词后底部
  // 大片空白不收缩的根因）
  var report = function () {
    post({
      type: 'onedict-height',
      // offsetHeight（html 盒实高 = 内容高）而非 scrollHeight：后者对根元素取
      // max(内容高, iframe 视口高)，会给短词条垫出 420px 级别的白尾巴
      h: document.documentElement.offsetHeight,
      t: typeof ONEDICT_LOOKUP_TOKEN === 'number' ? ONEDICT_LOOKUP_TOKEN : null,
    });
  };
  window.addEventListener('load', report);
  if (document.readyState === 'complete') report();
  if (window.ResizeObserver) {
    new ResizeObserver(report).observe(document.documentElement);
  }
})();
<\/script>
`;

/** srcdoc 组装参数（扩展位 webdict）：
 *  css = 帧内样式（在线词典 opaque origin 不继承父页，必须自带；vite ?raw 注入）
 *  allowExternal = 帧内 http(s) 链接委托父页面内置网页窗口（open_webview）；
 *                   本地词条帧保持 http 链接 preventDefault 的死链语义不变 */
export interface SrcdocOptions {
  css?: string;
  allowExternal?: boolean;
}

export function buildSrcdoc(
  entryHtml: string,
  lookupToken?: number,
  opts?: SrcdocOptions,
): string {
  const token = typeof lookupToken === "number" ? lookupToken : "null";
  const flags = `<script>var ONEDICT_LOOKUP_TOKEN=${token};var ONEDICT_ALLOW_EXTERNAL=${opts?.allowExternal ? "true" : "false"};<\/script>`;
  const css = opts?.css ? `<style>${opts.css}</style>` : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_self">${flags}${css}${BOOT_SCRIPT}</head><body>${entryHtml}</body></html>`;
}
