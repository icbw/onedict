mod ai;
mod autostart;
mod data;
mod dictionary;
mod edge_tts;
mod fsutil;
mod history;
mod ocr;
mod paths;
mod prefs;
mod reviewlog;
mod selection;
mod sys;
mod tray;
mod tts;
mod unitlog;
mod update;
mod vocabulary;
mod webdict;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动期读取铁律：tauri.conf.json 的 `app.windows` 在 setup 回调之前创建并开始
    // 加载页面，前端首载即 invoke 的数据（偏好 / 查词历史 / 翻译历史 / 生词本 /
    // 复习日志）必须在窗口创建前全部就绪——否则前端 `.catch` 吞错后停留在空态。
    // 用不依赖 AppHandle 的早期路径解析完成初始化；解析失败不中断启动（setup 内兜底再试）。
    let early_dir = match paths::data_root_early() {
        Ok(dir) => {
            prefs::init(&dir);
            Some(dir)
        }
        // tracing 尚未初始化（setup 内才装 subscriber），用 stderr 留痕
        Err(e) => {
            eprintln!("onedict: 早期数据根解析失败（setup 兜底）：{e}");
            None
        }
    };
    let mut builder = tauri::Builder::default();
    // 四 store 先行注册：DictionaryTab / VocabularyTab / TranslateTab 为 keep-alive
    // 常挂载页，挂载即调 history_list / vocabulary_list / vocabulary_review_log /
    // translate_history_list——晚于页面加载注册即首载化石态
    if let Some(dir) = &early_dir {
        builder = builder
            .manage(vocabulary::VocabularyStore::open(dir))
            .manage(reviewlog::ReviewLogStore::open(dir))
            .manage(unitlog::UnitLogStore::open(dir))
            .manage(history::HistoryStore::open(dir))
            .manage(history::translate::TranslateHistoryStore::open(dir));
    }
    builder
        //  单实例（须最先注册）：第二实例启动即退出并聚焦已有主窗口——
        // 防全局快捷键注册冲突 + 四处 JSON 并发写互相覆盖
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(dictionary::Registry::new())
        // 在线词典（webdict）：reqwest 常驻 client + 内存 LRU 缓存
        .manage(webdict::WebdictClient::new())
        //  收尾：全局快捷键插件（仅 Rust 侧使用，注册见 tray::register_hotkeys）
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 数据可携：文件保存/打开对话框（备份导出/恢复/Anki CSV）
        .plugin(tauri_plugin_dialog::init())
        // 开机启动：注册项读写由 autostart 模块按环境守卫调用；
        // `--autostart` 随注册值写入 Run 项，启动期据此识别「本次由登录自启拉起」
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::AUTOSTART_ARG]),
        ))
        // 应用内更新：端点与公钥取 tauri.conf.json 的 plugins.updater
        // （公钥必填——缺该段插件初始化即反序列化失败）；能力经自建命令暴露，
        // 不注册插件 IPC 权限
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 数据根目录（dev/release 分流，见 paths::data_root）：logs 与全部
            // JSON 数据/词典缓存的统一根。logs 失败兜底相对目录（tracing 未就绪
            // 前不阻断启动）；数据目录失败则中止（与原 app_data_dir 语义一致）。
            let root = paths::data_root(app.handle());
            //  可观测：stdout（dev 终端）+ 滚动文件双写——release
            // 为 GUI 子系统无 stdout，此前现场问题不可诊断。文件在数据根/logs/
            // 按天滚动（onedict.log.YYYY-MM-DD）。
            let logs_dir = root
                .as_ref()
                .map(|d| d.join("logs"))
                .unwrap_or_else(|_| std::path::PathBuf::from("logs"));
            let _ = std::fs::create_dir_all(&logs_dir);
            let (file_writer, log_guard) =
                tracing_appender::non_blocking(tracing_appender::rolling::daily(&logs_dir, "onedict.log"));
            // WorkerGuard 须存活整个进程生命周期（drop 即停止刷盘）——进程即日志生命周期
            std::mem::forget(log_guard);
            use tracing_subscriber::layer::SubscriberExt as _;
            use tracing_subscriber::util::SubscriberInitExt as _;
            tracing_subscriber::registry()
                .with(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "info".into()),
                )
                .with(tracing_subscriber::fmt::layer()) // stdout（dev 终端，保留 ANSI 色）
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_ansi(false) // 文件无色
                        .with_writer(file_writer),
                )
                .init();
            // 登录自启（Run 值带 --autostart）：不弹主窗，静默驻留托盘（划词/托盘
            // 服务照常启动）。窗口在 Builder::build 内创建而 setup 早于事件循环，
            // 此处 hide 不产生首帧闪窗。
            if std::env::args().any(|a| a == autostart::AUTOSTART_ARG) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                tracing::info!(target: "app", "登录自启：静默启动到托盘");
            }
            //  生词卡存储：数据根/vocabulary.json（JSON 单文件，schema 沿用 pickdict）；
            // prefs / dict-cache / review-log / history 同根（全部走 dev/release 分流）
            let data_dir = root.map_err(|e| format!("取数据目录失败: {e}"))?;
            //  偏好先行（selection 恢复依赖）：正常已在 run() 开头完成（窗口创建
            // 之前）——那里的日志发生在 subscriber 就绪前被丢弃，此处补打一条摘要。
            if prefs::is_initialized() {
                prefs::log_loaded();
            } else {
                prefs::init(&data_dir);
            }
            // 词典索引缓存不在此创建：应用依赖数据归安装目录
            // dict-cache\，由 Registry 首次打开词典时惰性创建（无词典无缓存；
            // 不可写时 UAC 提权），启动流程零目录预建
            // 四 store 兜底：正常路径已在 run() 开头（窗口创建前）注册，
            // 此处仅早期数据根解析失败时补注册——try_state 防重复 manage
            if app.try_state::<vocabulary::VocabularyStore>().is_none() {
                app.manage(vocabulary::VocabularyStore::open(&data_dir));
            }
            // 学习统计：复习日志按天聚合（review-log.json）
            if app.try_state::<reviewlog::ReviewLogStore>().is_none() {
                app.manage(reviewlog::ReviewLogStore::open(&data_dir));
            }
            // 单元复习日志：轮次 / 抽查 / 分组记录（unit-log.json）
            if app.try_state::<unitlog::UnitLogStore>().is_none() {
                app.manage(unitlog::UnitLogStore::open(&data_dir));
            }
            //  查词历史持久化（app_data_dir()/history.json）
            if app.try_state::<history::HistoryStore>().is_none() {
                app.manage(history::HistoryStore::open(&data_dir));
            }
            //  翻译历史持久化（app_data_dir()/translate-history.json）
            if app.try_state::<history::translate::TranslateHistoryStore>().is_none() {
                app.manage(history::translate::TranslateHistoryStore::open(&data_dir));
            }
            selection::init(app.handle().clone());
            selection::restore_from_prefs();
            //  收尾：托盘常驻（左键显示主窗，右键菜单 显示/划词开关/退出）。
            // 须在 selection::init 之后——菜单勾选态读划词状态。
            if let Err(e) = tray::init(app.handle()) {
                tracing::error!(target: "tray", error = %e, "托盘初始化失败（无托盘常驻，关窗仍隐藏）");
            }
            //  收尾：全局快捷键（划词开关 Ctrl+Alt+D / 查词呼出 Ctrl+Alt+Space；
            // 注册失败降级为告警，不阻断启动）
            tray::register_hotkeys(app.handle());
            // 词典预热（后台低优先级，延迟 2.5s）：主启动流程不等待，前台首帧不被抢 CPU
            dictionary::spawn_warmup(app.handle().clone());
            // 更新检查（偏好开启时，默认关）：延迟后台执行，结果广播 `update-available`
            update::spawn_startup_check(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            selection::selection_set_enabled,
            selection::selection_get_perf,
            selection::selection_set_clipboard_fallback,
            selection::selection_set_clipboard_lookup,
            dictionary::dictionary_list,
            dictionary::dictionary_load,
            dictionary::dictionary_lookup,
            dictionary::dictionary_associate,
            dictionary::dictionary_sound,
            dictionary::dictionary_remove,
            vocabulary::vocabulary_list,
            vocabulary::vocabulary_review_log,
            vocabulary::vocabulary_has,
            vocabulary::vocabulary_add,
            vocabulary::vocabulary_remove,
            vocabulary::vocabulary_review,
            vocabulary::vocabulary_unit_list,
            vocabulary::vocabulary_unit_create,
            vocabulary::vocabulary_unit_rename,
            vocabulary::vocabulary_unit_remove,
            vocabulary::vocabulary_unit_update,
            vocabulary::vocabulary_move,
            vocabulary::vocabulary_group_apply,
            vocabulary::vocabulary_group_undo,
            vocabulary::vocabulary_unit_round_commit,
            vocabulary::vocabulary_unit_check_commit,
            vocabulary::vocabulary_unit_log,
            history::history_list,
            history::history_add,
            history::history_clear,
            history::history_remove,
            history::translate::translate_history_list,
            history::translate::translate_history_add,
            history::translate::translate_history_clear,
            selection::selection_open_panel,
            selection::selection_set_panel_pinned,
            selection::selection_hide_panel,
            selection::selection_hide_toolbar,
            selection::selection_set_toolbar_size,
            selection::selection_notice_size,
            sys::open_external,
            sys::open_logs_dir,
            sys::app_restart,
            sys::clipboard_write,
            sys::clipboard_write_image,
            autostart::autostart_status,
            autostart::autostart_set,
            ocr::ocr_screen_snapshot,
            ocr::ocr_focus_capture,
            prefs::prefs_get,
            prefs::prefs_set_selection_capture,
            prefs::prefs_set_dict_root,
            prefs::prefs_set_action_items,
            prefs::prefs_set_dict_items,
            prefs::prefs_set_ai,
            prefs::prefs_set_translate_lang,
            prefs::prefs_set_translate_source_lang,
            prefs::prefs_set_toolbar_compact,
            prefs::prefs_set_translate_config,
            prefs::prefs_set_hotkeys,
            prefs::prefs_set_review_auto_pronounce,
            prefs::prefs_set_web_external,
            prefs::prefs_set_ocr_lang,
            prefs::prefs_set_ocr_target_lang,
            prefs::prefs_set_ocr_vision_model,
            prefs::prefs_set_ocr_auto_recognize,
            prefs::prefs_set_check_update_on_startup,
            prefs::prefs_set_pronounce,
            ocr::ocr_recognize_region,
            ocr::ocr_capture_region,
            ocr::ocr_recognize_captured,
            ocr::ocr_open_panel,
            ocr::ocr_languages,
            ocr::ocr_hide_capture,
            ai::ai_stream,
            ai::ai_stream_cancel,
            ai::ai_models,
            webdict::webdict_lookup,
            webdict::webdict_audio,
            webdict::webdict_clear_cache,
            edge_tts::edge_tts_voices,
            edge_tts::edge_tts_synthesize,
            tts::tts_voices,
            tts::tts_synthesize,
            data::data_backup,
            data::data_restore,
            data::data_location,
            data::data_migrate,
            data::data_reset_location,
            data::vocabulary_export_anki,
            update::update_env,
            update::update_pending,
            update::update_check,
            update::update_download,
            update::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            let tauri::RunEvent::WindowEvent { label, event, .. } = event else {
                return;
            };
            match event {
                //  收尾：主窗口关闭 = 隐藏到托盘（pickdict TrayService 语义）。
                // 原「关窗即 exit(0)」是过渡期的临时方案（selection-toolbar 常驻导致
                // 「全部窗口关闭才退出」永不满足）；托盘就位后常驻进程显式可见，
                // 托盘「退出」是唯一且明确的退出路径，划词钩子隐藏后继续服务。
                tauri::WindowEvent::CloseRequested { api, .. } if label == "main" => {
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    tracing::info!(target: "app", "主窗口隐藏到托盘（托盘退出以结束进程）");
                }
                //  动作面板：拦截销毁改为隐藏（窗口预建复用；实测 Alt+触发默认
                // CloseRequested 销毁后 get_webview_window 返回 None，面板从此打不开）
                tauri::WindowEvent::CloseRequested { api, .. } if label == "action-panel" => {
                    api.prevent_close();
                    if let Some(panel) = app_handle.get_webview_window("action-panel") {
                        let _ = panel.hide();
                    }
                }
                //  OCR 覆盖层：同预建复用语义（关窗改隐藏；失焦收起走去抖
                // 复查——识别序列 hide→show 会产生乱序 Focused(false)，立即隐藏会把
                // 刚 show 回的窗口误杀，实测「松开选框即闪退」的根因）
                tauri::WindowEvent::CloseRequested { api, .. } if label == "ocr-capture" => {
                    api.prevent_close();
                    if let Some(w) = app_handle.get_webview_window("ocr-capture") {
                        let _ = w.hide();
                    }
                }
                tauri::WindowEvent::Focused(false) if label == "ocr-capture" => {
                    ocr::hide_capture_on_blur(app_handle);
                }
                //  动作面板失焦 → 隐藏（pickdict auto_close；pinned 时常驻）
                tauri::WindowEvent::Focused(false) if label == "action-panel" => {
                    selection::hide_panel_on_blur(app_handle);
                }
                _ => {}
            }
        });
}
