//! 在线词典（有道 / 剑桥 / 必应）。分层：**Rust 只做 HTTP 传输**（复用
//! reqwest，绕 webview CORS），HTML 语义理解全部在前端 webview（DOMParser +
//! DOMPurify，见 src/services/webdict/）——与 AI 管线同构。
//!
//! 安全面：
//! - `webdict_lookup` 只收 `dict_id + word`，URL 由本模块静态注册表构造——
//!   命令永远不是任意 URL 代理（SSRF 面为零）。
//! - `webdict_audio` 是唯一收 URL 的命令（发音资源地址只能由解析层给出），
//!   host 白名单兜底（精确或子域后缀匹配）。
//! - 缓存仅内存 LRU（200 条 / TTL 30min）：站点内容不落盘不分发（版权边界），
//!   同词反复重查（切页/跳词）不重复打站点。
//!
//! 错误约定（前端 errors.ts 类型化依据）：`TIMEOUT` / `FORBIDDEN`（站点反爬，
//! 前端给「在浏览器中打开」人工验证入口）/ `HTTP <status>` / `NETWORK: <e>`。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use futures_util::StreamExt;
use serde::Serialize;
use url::Url;

/// 桌面 Chrome UA（不带任何 cookie；两站实测直连可达，见调研报告 §3）
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE: &str = "zh-CN,zh;q=0.9,en;q=0.8";
/// 超时预算：实测两站 P99 < 1s，10s 约 10 倍余量（saladict 25s 是扩展场景历史值）
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_CAP: usize = 200;
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);

/// 发音资源 host 白名单（精确或 `.<host>` 子域后缀）。
const AUDIO_HOSTS: &[&str] = &["dict.youdao.com", "dictionary.cambridge.org", "bing.com"];

// ── 静态注册表：dict_id → URL 构造（URL 只在 Rust 侧成形） ──

/// 查询页 URL。未知 dict_id → None（命令报错）。word 需已 trim（前端入口归一，
/// 此处兜底再 trim 一次）。
fn build_url(dict_id: &str, word: &str) -> Option<String> {
    match dict_id {
        "web-youdao" => {
            // base 不带尾斜杠（带尾斜杠会多一个空段，产出 /w//word）
            let mut u = Url::parse("https://dict.youdao.com/w").ok()?;
            u.path_segments_mut().ok()?.push(word.trim());
            Some(u.into())
        }
        //  剑桥：英汉简体站（实测 200 直连；未收录词 302 →
        // spellcheck 页，前端无 .di-title 判 NO_RESULT）
        "web-cambridge" => {
            let mut u = Url::parse(
                "https://dictionary.cambridge.org/dictionary/english-chinese-simplified",
            )
            .ok()?;
            u.path_segments_mut().ok()?.push(word.trim());
            Some(u.into())
        }
        //  必应：客户端条目页（轻量 HTML，含英汉/英英/网络三个标签面板）
        "web-bing" => {
            let mut u = Url::parse("https://cn.bing.com/dict/clientsearch").ok()?;
            u.query_pairs_mut()
                .append_pair("mkt", "zh-CN")
                .append_pair("setLang", "zh")
                .append_pair("form", "BDVEHC")
                .append_pair("ClientVer", "BDDTV3.5.1.4320")
                .append_pair("q", word.trim());
            Some(u.into())
        }
        _ => None,
    }
}

fn audio_host_allowed(host: &str) -> bool {
    AUDIO_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

// ── 内存 LRU（简单实现：HashMap 存值 + 队列记插入序，超容淘汰队首） ──

struct LruCache {
    map: HashMap<(String, String), (Instant, String)>,
    order: VecDeque<(String, String)>,
}

impl LruCache {
    fn get(&mut self, key: &(String, String)) -> Option<String> {
        let (at, html) = self.map.get(key)?;
        if at.elapsed() > CACHE_TTL {
            self.map.remove(key); // 惰性过期：命中时剔除，容量由淘汰路径回收
            return None;
        }
        Some(html.clone())
    }

    fn put(&mut self, key: (String, String), html: String) {
        self.map.insert(key.clone(), (Instant::now(), html));
        self.order.push_back(key);
        while self.map.len() > CACHE_CAP {
            match self.order.pop_front() {
                Some(k) => {
                    self.map.remove(&k);
                }
                None => break,
            }
        }
    }
}

pub struct WebdictClient {
    /// 查询页 client（静态注册表构造 URL；重定向不限——站点跳验证页属正常行为）
    http: reqwest::Client,
    /// 发音资源 client（安全修复）：`webdict_audio` 是唯一收 URL 的
    /// 命令，初始 URL 校验可被 302 带出白名单（reqwest 默认跟随 ≤10 跳）——
    /// 此 client 重定向逐跳复检 host 白名单。
    audio: reqwest::Client,
    cache: Mutex<LruCache>,
}

impl WebdictClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("webdict http client 构造失败");
        let audio = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() > 5 {
                    return attempt.error("too many redirects");
                }
                match attempt.url().host_str() {
                    Some(h) if audio_host_allowed(h) => attempt.follow(),
                    _ => attempt.error("redirect target host not allowed"),
                }
            }))
            .build()
            .expect("webdict audio client 构造失败");
        Self {
            http,
            audio,
            cache: Mutex::new(LruCache {
                map: HashMap::new(),
                order: VecDeque::new(),
            }),
        }
    }

    fn cache_get(&self, key: &(String, String)) -> Option<String> {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
    }

    fn cache_put(&self, key: (String, String), html: String) {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .put(key, html);
    }

    fn cache_clear(&self) {
        let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        c.map.clear();
        c.order.clear();
    }
}

impl Default for WebdictClient {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri commands ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdictResult {
    /// 原始 HTML（入口不消毒照搬 saladict：语义理解在前端，消毒在取值出口）
    pub html: String,
    pub from_cache: bool,
    /// 来源页 URL（错误态「在浏览器中打开」入口）
    pub src_page: String,
}

#[tauri::command]
pub async fn webdict_lookup(
    state: tauri::State<'_, WebdictClient>,
    dict_id: String,
    word: String,
) -> Result<WebdictResult, String> {
    let Some(url) = build_url(&dict_id, &word) else {
        return Err(format!("未知在线词典: {dict_id}"));
    };
    let key = (dict_id, word.trim().to_string());
    if let Some(html) = state.cache_get(&key) {
        return Ok(WebdictResult {
            html,
            from_cache: true,
            src_page: url,
        });
    }
    let resp = state
        .http
        .get(&url)
        .header(reqwest::header::ACCEPT_LANGUAGE, ACCEPT_LANGUAGE)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "TIMEOUT".to_string()
            } else {
                format!("NETWORK: {e}")
            }
        })?;
    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("FORBIDDEN".into());
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let html = resp.text().await.map_err(|e| format!("NETWORK: {e}"))?;
    state.cache_put(key, html.clone());
    Ok(WebdictResult {
        html,
        from_cache: false,
        src_page: url,
    })
}

/// 发音资源下载（裸 mp3，无需 speex 解码；与 dictionary_sound 同构返回，
/// 复用前端 `onedict-sound-data` 播放通道）。
#[tauri::command]
pub async fn webdict_audio(
    state: tauri::State<'_, WebdictClient>,
    url: String,
) -> Result<crate::dictionary::SoundResult, String> {
    let parsed = Url::parse(&url).map_err(|e| format!("URL 无效: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(format!("协议不允许: {}", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !audio_host_allowed(host) {
        return Err(format!("音频域名不在白名单: {host}"));
    }
    let resp = state
        .audio
        .get(parsed.as_str())
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "TIMEOUT".to_string()
            } else {
                format!("NETWORK: {e}")
            }
        })?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            s.split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|s| s.starts_with("audio/"))
        .unwrap_or_else(|| "audio/mpeg".into());
    // body 流式读带上限：发音资源正常 < 1MB；无上限的 bytes() 可被
    // 超大响应拖爆内存
    const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
    let mut stream = resp.bytes_stream();
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("NETWORK: {e}"))?;
        if bytes.len() + chunk.len() > MAX_AUDIO_BYTES {
            return Err(format!("音频资源超过 {}MB 上限", MAX_AUDIO_BYTES / 1024 / 1024));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(crate::dictionary::SoundResult {
        base64: Some(STANDARD.encode(&bytes)),
        mime,
    })
}

/// 清缓存（设置页/调试用）
#[tauri::command]
pub fn webdict_clear_cache(state: tauri::State<WebdictClient>) {
    state.cache_clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_encodes_path_segments() {
        assert_eq!(
            build_url("web-youdao", "hello world").unwrap(),
            "https://dict.youdao.com/w/hello%20world"
        );
        // 路径分隔符必须编码（词头里的 / 是内容不是路径）
        assert_eq!(
            build_url("web-youdao", "a/b").unwrap(),
            "https://dict.youdao.com/w/a%2Fb"
        );
        assert_eq!(
            build_url("web-youdao", " test ").unwrap(),
            "https://dict.youdao.com/w/test"
        );
        assert!(build_url("web-unknown", "x").is_none(), "未知 dict_id 拒绝构造");
    }

    #[test]
    fn build_url_bing_carries_query_params() {
        let u = build_url("web-bing", "hello world").unwrap();
        let parsed = Url::parse(&u).unwrap();
        assert_eq!(parsed.path(), "/dict/clientsearch");
        let pairs: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("q").map(String::as_str), Some("hello world"));
        assert_eq!(pairs.get("mkt").map(String::as_str), Some("zh-CN"));
        // 词头里的 & 与 / 是内容不是分隔符（query_pairs 负责 percent 编码）
        let u2 = build_url("web-bing", "a&b/c").unwrap();
        let parsed2 = Url::parse(&u2).unwrap();
        let pairs2: HashMap<_, _> = parsed2.query_pairs().into_owned().collect();
        assert_eq!(pairs2.get("q").map(String::as_str), Some("a&b/c"));
    }

    #[test]
    fn lru_evicts_oldest_beyond_cap() {
        let mut c = LruCache {
            map: HashMap::new(),
            order: VecDeque::new(),
        };
        for i in 0..=CACHE_CAP {
            c.put(("d".into(), i.to_string()), format!("v{i}"));
        }
        assert_eq!(c.map.len(), CACHE_CAP);
        assert!(c.get(&("d".into(), "0".into())).is_none(), "最旧条目被淘汰");
        assert!(c.get(&("d".into(), CACHE_CAP.to_string())).is_some());
    }

    #[test]
    fn audio_whitelist_exact_and_subdomain() {
        assert!(audio_host_allowed("dict.youdao.com"));
        assert!(audio_host_allowed("a.dict.youdao.com"));
        assert!(audio_host_allowed("dictionary.cambridge.org"));
        assert!(audio_host_allowed("bing.com"));
        assert!(audio_host_allowed("cn.bing.com"));
        assert!(!audio_host_allowed("evilyoudao.com"));
        assert!(!audio_host_allowed("youdao.com.evil.io"));
        assert!(!audio_host_allowed(""));
    }
}
