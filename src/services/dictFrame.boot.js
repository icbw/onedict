/**
 * 词条 iframe 引导脚本（BOOT_SCRIPT 正文）：点击委托（entry:// 重查 / sound://·
 * webaudio:// 播放回传 / say:// 例句朗读）+ 高度上报 + 例句朗读按钮注入。
 *
 * **本文件是真实 .js**，由 `dictFrame.ts` 用 vite `?raw` 内联进 srcdoc——不要改写成
 * TS 模板字符串：打包产物里模板（含 String.raw）会被改写，实测正则转义被吃掉
 * （\s+ 变 s+）、内联的函数源码被折叠成 `,`，帧脚本不报错但静默失效：查词照常，
 * 而例句按钮、帧内取词、拖选词组查询全都不工作（dev 下不复现）。
 *
 * 依赖 saySegments.js 的 saySegmentsOf：dictFrame.ts 在每个 srcdoc 里把它先注入，
 * 故这里是经典脚本顶层作用域可见的普通函数（与注入文本同一份源码）。
 *
 * 修改后跑基线：node test/frame.mjs（语法 + 文本保真 + srcdoc 组装 + 分段规则 + 迷你 DOM 注入）。
 */
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
  // ── 发音单通道：帧内同时只播一条音频。音频经父页面下载/解码后回传
  // onedict-sound-data（一次往返），故：
  //   ① 点击即登记轮次 seq，父页面原样回传——连点不同喇叭时先到的过期响应丢弃，
  //      否则旧音频会盖住新点击（例句连读场景）；
  //   ② 起播前先停上一条（此前每条 new Audio 各播各的，两条朗读叠在一起）；
  //   ③ 同一锚点在播时再点 = 停止（发音按钮兼作停止开关，锚点加 is-playing 高亮）。
  var soundEl = null; // 播放中的 Audio
  var soundAnchor = null; // 播放中锚点（仅本项目生成的 webdict-Speaker 参与高亮）
  var soundSeq = 0; // 发音点击轮次（父页面回传）
  var soundHref = ''; // 最近一次点击的锚点标识（回传响应对应关系）
  var playingHref = ''; // 正在播放的锚点标识（同锚点再点 = 停）
  var soundTimer = null; // 起播看门狗（媒体停滞时上报，避免「点了没声音也没反应」）
  var clearSound = function () {
    if (soundTimer) {
      clearTimeout(soundTimer);
      soundTimer = null;
    }
    var el = soundEl;
    soundEl = null;
    if (el) {
      try {
        el.pause();
        el.removeAttribute('src'); // 释放解码资源（长会话反复播放不堆积）
        el.load();
      } catch (err) {}
    }
    if (soundAnchor && soundAnchor.classList) soundAnchor.classList.remove('is-playing');
    soundAnchor = null;
    playingHref = '';
  };
  // 音标窗口（UK /teɪk/、美 [teɪk]）不是可读文本：返回空串，父页回落查询词——
  // 否则单词发音锚点会被当成句子读（音标混读 + 走错场景设置）。
  // 注：本脚本内嵌在模板字符串里，正则中的转义反斜杠必须双写（单写会被吞掉反斜杠，
  // 让正则字面量提前闭合、破坏整段脚本），故括注改用字符扫描、区域标签改用 token
  // 比对，本段不出现转义字符。
  var REGION_TOKENS = ['uk', 'us', 'gb', 'br', 'bre', 'ame', 'nam'];
  var stripBrackets = function (s) {
    var out = '';
    var i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === '/' || ch === '[') {
        var close = ch === '/' ? '/' : ']';
        var j = s.indexOf(close, i + 1);
        if (j > i && j - i <= 80) {
          out += ' ';
          i = j + 1;
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  };
  var hasCJK = function (s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x3040 && c <= 0x30ff) return true;
      if (c >= 0x3400 && c <= 0x9fff) return true;
      if (c >= 0xac00 && c <= 0xd7af) return true;
    }
    return false;
  };
  var isIpaOnly = function (t) {
    var rest = stripBrackets(t).replace(/[英美·]/g, ' ');
    if (hasCJK(rest)) return false; // 有汉字 / 假名 → 是句子或词组
    var toks = rest.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ');
    for (var i = 0; i < toks.length; i++) {
      if (toks[i] && REGION_TOKENS.indexOf(toks[i]) < 0) return false;
    }
    return true;
  };
  var pickSpeakText = function (a) {
    var own = (a.textContent || '').replace(/\s+/g, ' ').trim();
    var node = a.parentNode;
    for (var i = 0; i < 4 && node && node !== document.body; i++, node = node.parentNode) {
      var t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t === own || t.length < 2) continue;
      if (t.length > 240) break; // 太大（整条释义）→ 放弃，父页回落查询词
      if (isIpaOnly(t)) return ''; // 音标窗口：按单词读，不读音标
      return t;
    }
    return '';
  };
  var pickAccent = function (a) {
    // 生成端标记（data-accent）优先：在线词典 UK / US 锚点的权威口音来源，
    // 音频资源缺失走合成兜底时按它选英 / 美音色
    var mark = ((a.getAttribute && a.getAttribute('data-accent')) || '').toLowerCase();
    if (mark === 'gb' || mark === 'us') return mark;
    var s = '';
    var node = a;
    for (var i = 0; i < 3 && node; i++, node = node.parentElement) {
      s += ' ' + (node.className || '');
      if (node.getAttribute) s += ' ' + (node.getAttribute('title') || '');
    }
    s += ' ' + (a.textContent || '');
    s = s.toLowerCase();
    if (/英|英式|british|bre\b|\buk\b|en[-_]?gb/.test(s)) return 'gb';
    if (/美|美式|american|nam[ea]|\bus\b|en[-_]?us/.test(s)) return 'us';
    return '';
  };
  var startSound = function (a, href, msg) {
    if (soundEl && !soundEl.paused && playingHref === href) {
      clearSound(); // 同一喇叭再点 = 停
      return;
    }
    soundSeq += 1;
    soundHref = href;
    soundAnchor = a.classList && a.classList.contains('webdict-Speaker') ? a : null;
    msg.seq = soundSeq;
    post(msg);
  };
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
      word = word.replace(/\/+$/, ''); // pickdict #21：目录式跨词条链接尾斜杠必 MISS
      post({ type: 'onedict-entry', word: word });
    } else if (href.indexOf('sound://') === 0) {
      e.preventDefault();
      startSound(a, href, {
        type: 'onedict-sound',
        key: href.slice(8),
        text: pickSpeakText(a),
        accent: pickAccent(a),
      });
    } else if (href.indexOf('webaudio://') === 0) {
      // 在线词典发音锚点（URL percent 编码存放）：委托父页面 webdict_audio 下载
      e.preventDefault();
      var audioUrl = href.slice(11);
      try { audioUrl = decodeURIComponent(audioUrl); } catch (err) {}
      startSound(a, href, {
        type: 'onedict-webaudio',
        url: audioUrl,
        text: pickSpeakText(a),
        accent: pickAccent(a),
      });
    } else if (href.indexOf('say://') === 0) {
      // 例句朗读按钮（帧内注入的 TTS 入口）：父页按「句子」场景 + 按钮槽合成回帧
      e.preventDefault();
      var sayText = a.getAttribute('data-text') || '';
      var sayWhich = a.getAttribute('data-which') === 'b' ? 'b' : 'a';
      if (sayText) startSound(a, href, { type: 'onedict-speak', text: sayText, which: sayWhich });
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
  // 主窗口解码完成回传 → 播放（用户点击手势链路内；被 autoplay 拦截时上报错误）；
  // 另接朗读按钮外观刷新（设置页改「朗读按钮」后即时改写既有喇叭的颜色与提示）
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'onedict-say-buttons') {
      applySayButtons(d.buttons);
      return;
    }
    if (d.type === 'onedict-sound-data' && d.base64) {
      // 过期响应（已被后续点击取代）丢弃：父页面按请求先后回传，慢的那条会晚到
      if (typeof d.seq === 'number' && d.seq !== soundSeq) return;
      clearSound();
      try {
        var audio = new Audio('data:' + d.mime + ';base64,' + d.base64);
        soundEl = audio;
        playingHref = soundHref;
        if (soundAnchor) soundAnchor.classList.add('is-playing');
        audio.addEventListener('ended', function () {
          if (soundEl === audio) clearSound();
        });
        audio.play().catch(function (err) {
          // 已被后续点击 / 停止取代（play 被打断 → AbortError）：静默丢弃。缺这道门禁时
          // 旧请求的拒绝会被报成「浏览器阻止了自动播放」，用户照提示重试也无效，且与真实
          // 原因（解码 / 媒体管线）对不上——提示必须指向可复现的事实
          if (soundEl !== audio) return;
          clearSound();
          var name = err && err.name ? String(err.name) : '';
          post({
            type: 'onedict-sound-error',
            msg:
              name === 'NotAllowedError'
                ? '浏览器阻止了自动播放，请再点一次发音按钮'
                : '音频无法播放（' + (name || '媒体管线异常') + '），请再点一次',
          });
        });
        // 起播看门狗：媒体解析出时长却停滞不播（系统音频输出异常）时上报，
        // 父页据此上屏提示——否则用户只看到「点了没声音也没反应」
        soundTimer = setTimeout(function () {
          if (soundEl !== audio || audio.currentTime > 0) return;
          clearSound();
          post({
            type: 'onedict-sound-error',
            msg: '音频未能开始播放（系统音频输出异常，请检查输出设备后重试）',
          });
        }, 4000);
      } catch (err) {
        clearSound();
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
  // ── 例句朗读按钮：词典自带音频锚点覆盖不到的长句（例句 / 释义）就地注入两个小喇叭
  // （按钮 1 = 女声、按钮 2 = 男声，英文口音倾向由设置页分配）——点击走父页合成
  // （「句子」场景 + 朗读按钮），回帧播放（与锚点同通道，单通道 + seq 门禁不变）。
  // 外观**不带文字**：颜色即性别（红 = 女声 / 蓝 = 男声），音色细节进悬停提示——
  // 图标必须是内联 SVG 取 currentColor，emoji 不随 CSS 变色。
  //
  // 词典帧正文结构不可控（本地 MDX 千奇百怪、在线源是我们生成的受限结构），按钮不由
  // 生成端拼 HTML，而是在帧内扫文本、按语言分段后就地注入。四条要点：
  //   ① **异步**：扫描排在 load 之后的空闲切片里分批做——首屏内容与高度上报不被扫描
  //      挡住（在线源单页可达数百 KB，同步扫描会把高度上报推迟到扫描结束，表现为
  //      查词后长时间空白，而扫描与查词性能本就无关，没必要挤在关键路径上）；
  //   ② **归属 = 最近的块级容器**：每个文本节点只归它最近的块级祖先——嵌套结构
  //      （li 里套 p、示例 div 里套译文 div）不再漏，也不会重复注入；块边界与 <br>
  //      记为分隔，组内文本不跨块连读；
  //   ③ **按语言分段**（saySegmentsOf）：中文段 / 英文段各得一对按钮，按钮落在该段
  //      末尾——英汉对照的例句不再用同一个音色把两种语言连着念（音色由段语言决定：
  //      中文取中文槽只看性别，英文按口音倾向 + 性别）；
  //   ④ 含发音锚点的组跳过（真人音频优先，同一句不给两个入口）。
  // 异常一律就地吞掉：帧脚本抛错会让高度不上报（词典全空白），扫描出错只应表现为
  // 「少一对按钮」——故按容器 try/catch，扫描整体再兜一层。
  var saySeq = 0;
  var SAY_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/>' +
    '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
  var SAY_FALLBACK = [{ accent: 'us', gender: 'f' }, { accent: 'gb', gender: 'm' }];
  // 按钮外观（父页按偏好注入：gender 决定颜色，accent 只对英文文本进悬停提示）
  var sayButtons = (function () {
    var m = window.ONEDICT_SAY_BUTTONS;
    if (m && m.length === 2 && m[0] && m[1] && m[0].gender && m[1].gender) return m;
    return SAY_FALLBACK;
  })();
  // 口音倾向只对英文有意义（中文 / 其他语言只报性别）——lang 取自分段结果，
  // 与父页 detectLang 同判据，故提示与实际音色一致
  var sayLabel = function (info, lang) {
    var gender = info.gender === 'm' ? '男声' : '女声';
    return lang === 'en'
      ? (info.accent === 'gb' ? '英音' : '美音') + ' · ' + gender
      : gender;
  };
  var paintSay = function (b) {
    var k = b.getAttribute('data-which') === 'b' ? 1 : 0;
    var info = sayButtons[k] || SAY_FALLBACK[k];
    b.className = 'onedict-say ' + (info.gender === 'm' ? 'g-m' : 'g-f');
    b.setAttribute('title', '朗读这句（' + sayLabel(info, b.getAttribute('data-lang')) + '）');
    b.innerHTML = SAY_ICON;
  };
  // 设置页改「朗读按钮」→ 父页广播新外观：改写已在页面上的喇叭（免重新查词）
  var applySayButtons = function (m) {
    if (!m || m.length !== 2 || !m[0] || !m[1] || !m[0].gender || !m[1].gender) return;
    sayButtons = m;
    var btns = document.querySelectorAll('.onedict-say');
    for (var i = 0; i < btns.length; i++) paintSay(btns[i]);
  };
  var sayStyled = false;
  var ensureSayStyle = function () {
    if (sayStyled) return;
    sayStyled = true;
    var style = document.createElement('style');
    style.textContent =
      '.onedict-say{margin-left:4px;display:inline-block;width:12px;height:12px;' +
      'vertical-align:-1px;line-height:0;cursor:pointer;text-decoration:none;' +
      'opacity:.55;transition:opacity .15s}' +
      '.onedict-say:hover{opacity:1}' +
      '.onedict-say svg{display:block;width:12px;height:12px}' +
      // 颜色即性别：!important 挡词典自带的 a{color} 规则（第三方样式不可控）
      '.onedict-say.g-f{color:#e11d48!important}' +
      '.onedict-say.g-m{color:#2563eb!important}';
    document.head.appendChild(style);
  };
  // 块级容器（文本归属边界）与整棵跳过的子树；命中发音锚点的组标记 hasAudio
  var SAY_OWNERS = '|P|LI|DD|DT|TD|TH|DIV|SECTION|ARTICLE|ASIDE|BLOCKQUOTE|' +
    'FIGCAPTION|FIGURE|H1|H2|H3|H4|H5|H6|CAPTION|SUMMARY|';
  var SAY_SKIP = '|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|AUDIO|VIDEO|' +
    'BUTTON|INPUT|SELECT|TEXTAREA|';
  var SAY_AUDIO = 'a[href^="sound://"],a[href^="webaudio://"],.webdict-Speaker';
  var sayHas = function (list, tag) { return list.indexOf('|' + tag + '|') >= 0; };
  // 收集：深度优先走一遍，按最近块级祖先分组成「可读组」（items = 文本节点 / 分隔符）
  var collectSayOwners = function () {
    var owners = [];
    if (!document.body) return owners;
    var root = { el: document.body, items: [], hasAudio: false };
    owners.push(root);
    var walk = function (parent, rec) {
      var node = parent.firstChild;
      while (node) {
        var next = node.nextSibling; // 注入会改结构，先记后继
        if (node.nodeType === 3) {
          if (node.data) rec.items.push({ node: node });
        } else if (node.nodeType === 1) {
          var tag = String(node.tagName || '').toUpperCase();
          if (sayHas(SAY_SKIP, tag)) {
            node = next;
            continue;
          }
          if (node.matches && node.matches(SAY_AUDIO)) {
            rec.hasAudio = true; // 真人音频优先
            node = next;
            continue;
          }
          if (node.matches && node.matches('.onedict-say')) {
            node = next;
            continue;
          }
          if (tag === 'BR') {
            rec.items.push({ sep: true }); // 换行 = 硬断点（不跨行连读）
          } else if (sayHas(SAY_OWNERS, tag)) {
            rec.items.push({ sep: true }); // 块边界 = 本组断开
            var child = { el: node, items: [], hasAudio: false };
            owners.push(child);
            walk(node, child);
          } else {
            walk(node, rec); // 行内元素：文本归当前组
          }
        }
        node = next;
      }
    };
    walk(document.body, root);
    return owners;
  };
  // 段末 → 注入落点（节点 + 节点内偏移）；偏移落在节点内部时由调用方 splitText 断点
  var sayLocate = function (ranges, end) {
    var hit = null;
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (r.start >= end) break;
      hit = r;
      if (end < r.end) break;
    }
    if (!hit) hit = ranges[0];
    var len = (hit.node.data || '').length;
    var off = end - hit.start;
    if (off < 0) off = 0;
    if (off > len) off = len;
    return { node: hit.node, offset: off };
  };
  var injectSayOwner = function (rec) {
    if (rec.hasAudio || !rec.items.length) return;
    var el = rec.el;
    if (el && el.getAttribute && el.getAttribute('data-onedict-say')) return;
    var text = '';
    var ranges = [];
    for (var i = 0; i < rec.items.length; i++) {
      var it = rec.items[i];
      if (it.sep) {
        text += '\n';
        continue;
      }
      var d = it.node.data || '';
      ranges.push({ node: it.node, start: text.length, end: text.length + d.length });
      text += d;
    }
    var segs = saySegmentsOf(text);
    if (!segs.length || !ranges.length) return;
    if (el && el.setAttribute) el.setAttribute('data-onedict-say', '1');
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      var at = sayLocate(ranges, seg.end);
      if (!at) continue;
      var ref = at.node;
      if (at.offset > 0 && at.offset < (ref.data || '').length) {
        try { ref.splitText(at.offset); } catch (err) {} // 断在段末：按钮紧跟该段
      }
      // 落点在链接里 → 移到链接之后（<a> 不能嵌套 <a>，且点击会被链接吞掉）
      var holder = ref.parentNode;
      var link = holder && holder.closest ? holder.closest('a') : null;
      if (link && link.parentNode) ref = link;
      if (!ref.parentNode) continue;
      saySeq += 1;
      var after = ref.nextSibling; // 插在段末之后：两个按钮按 a / b 顺序排在原后继之前
      for (var k = 0; k < 2; k++) {
        var btn = document.createElement('a');
        btn.setAttribute('href', 'say://' + saySeq + '-' + k);
        btn.setAttribute('data-text', seg.text);
        btn.setAttribute('data-lang', seg.lang);
        btn.setAttribute('data-which', k === 0 ? 'a' : 'b');
        paintSay(btn);
        ref.parentNode.insertBefore(btn, after);
      }
    }
  };
  // 分片注入：每片最多干 8ms，让出主线程让帧继续渲染（高度靠 ResizeObserver 与收尾
  // 各上报一次，不必每片都报）
  var scanSayButtons = function () {
    ensureSayStyle();
    var owners = collectSayOwners();
    var i = 0;
    var step = function () {
      var t0 = Date.now();
      while (i < owners.length && Date.now() - t0 < 8) {
        try { injectSayOwner(owners[i]); } catch (err) {}
        i += 1;
      }
      if (i < owners.length) setTimeout(step, 0);
      else { try { report(); } catch (err) {} }
    };
    step();
  };
  var onReady = function () {
    report(); // 先上报高度：朗读按钮随后异步补上，不占首屏
    // 宿主不接 onedict-speak（复习卡帧）时父页显式关掉：否则满屏点了没反应的喇叭
    if (window.ONEDICT_SAY_ENABLED === false) return;
    var later = function () {
      try { scanSayButtons(); } catch (err) {}
    };
    if (window.requestIdleCallback) window.requestIdleCallback(later, { timeout: 600 });
    else setTimeout(later, 60);
  };
  window.addEventListener('load', onReady);
  if (document.readyState === 'complete') onReady();
  if (window.ResizeObserver) {
    new ResizeObserver(report).observe(document.documentElement);
  }
})();
