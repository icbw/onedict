//!  耗时埋点：抓取总耗时环形缓冲 + p95 统计。
//!
//! 度量链（capture.rs 打点）：t0 钩子回调鼠标 up → t1 worker 出队 → t2 UIA element/pattern
//! → t3 文本 → t4 包围盒 → t5 布局+show+emit。`total = t5 - t0` 进缓冲；决策门 = total p95 < 30ms。
//! 失败样本不进缓冲（单独计数），避免混入成功路径分布。

use std::collections::VecDeque;
use std::sync::Mutex;

const CAPACITY: usize = 256;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTimings {
    /// t1 - t0：hook → worker 排队等待
    pub queue_wait_ms: f64,
    /// t2 - t1：GetForegroundWindow/进程名 + GetFocusedElement + GetCurrentPattern
    pub uia_access_ms: f64,
    /// t3 - t2：GetSelection + GetText
    pub text_ms: f64,
    /// t4 - t3：GetBoundingRectangles
    pub rects_ms: f64,
    /// t5 - t4：布局计算 + 定位 + show（emit 在打点后，事件入队为亚毫秒级，不计入）
    pub layout_show_ms: f64,
    /// t5 - t0：决策门指标
    pub total_ms: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfStats {
    pub sample_count: usize,
    pub failure_count: u64,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub last_ms: f64,
    /// 剪贴板兜底成功样本数（不计入 p95 决策门分布）
    pub clipboard_sample_count: u64,
    pub clipboard_mean_ms: f64,
}

/// 环形缓冲本体：逻辑全部收敛为实例方法，可独立构造测试（无进程级共享态依赖）。
struct Ring {
    samples: VecDeque<f64>,
    failures: u64,
    clipboard: VecDeque<f64>,
    /// 最近一次成功样本（last_ms = 最近而非最大；原实现取
    /// `sorted.last()` 与 max_ms 恒等，语义错误）
    last_success: Option<f64>,
}

impl Ring {
    /// 生产路径 RING 由 const 初始化；new 仅供测试构造独立实例
    #[cfg(test)]
    fn new() -> Self {
        Self {
            samples: VecDeque::new(),
            failures: 0,
            clipboard: VecDeque::new(),
            last_success: None,
        }
    }

    /// UIA 路径成功样本（p95 决策门分布）
    fn record_success(&mut self, total_ms: f64) {
        if self.samples.len() >= CAPACITY {
            self.samples.pop_front();
        }
        self.samples.push_back(total_ms);
        self.last_success = Some(total_ms);
    }

    /// 剪贴板兜底成功样本（单独统计；耗时含注入与轮询等待，天然高于 UIA 路径）
    fn record_clipboard(&mut self, total_ms: f64) {
        if self.clipboard.len() >= CAPACITY {
            self.clipboard.pop_front();
        }
        self.clipboard.push_back(total_ms);
    }

    fn record_failure(&mut self) {
        self.failures = self.failures.wrapping_add(1);
    }

    fn stats(&self) -> PerfStats {
        let mut sorted: Vec<f64> = self.samples.iter().copied().collect();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let n = sorted.len();
        let mean =
            if n == 0 { 0.0 } else { sorted.iter().sum::<f64>() / n as f64 };
        let pct = |p: f64| -> f64 {
            if n == 0 {
                0.0
            } else {
                // 最近邻秩：ceil(p*n) - 1（n=1 时恒为 0）
                let idx =
                    ((p * n as f64).ceil() as usize).saturating_sub(1).min(n - 1);
                sorted[idx]
            }
        };
        let cb_n = self.clipboard.len();
        let cb_mean = if cb_n == 0 {
            0.0
        } else {
            self.clipboard.iter().sum::<f64>() / cb_n as f64
        };
        PerfStats {
            sample_count: n,
            failure_count: self.failures,
            mean_ms: mean,
            p50_ms: pct(0.50),
            p95_ms: pct(0.95),
            max_ms: sorted.last().copied().unwrap_or(0.0),
            last_ms: self.last_success.unwrap_or(0.0),
            clipboard_sample_count: cb_n as u64,
            clipboard_mean_ms: cb_mean,
        }
    }

    fn empty_stats() -> PerfStats {
        PerfStats {
            sample_count: 0,
            failure_count: 0,
            mean_ms: 0.0,
            p50_ms: 0.0,
            p95_ms: 0.0,
            max_ms: 0.0,
            last_ms: 0.0,
            clipboard_sample_count: 0,
            clipboard_mean_ms: 0.0,
        }
    }
}

static RING: Mutex<Ring> = Mutex::new(Ring {
    samples: VecDeque::new(),
    failures: 0,
    clipboard: VecDeque::new(),
    last_success: None,
});

/// UIA 路径成功样本（p95 决策门分布）
pub fn record_success(total_ms: f64) {
    if let Ok(mut ring) = RING.lock() {
        ring.record_success(total_ms);
    }
}

/// 剪贴板兜底成功样本（单独统计；耗时含注入与轮询等待，天然高于 UIA 路径）
pub fn record_clipboard(total_ms: f64) {
    if let Ok(mut ring) = RING.lock() {
        ring.record_clipboard(total_ms);
    }
}

pub fn record_failure() {
    if let Ok(mut ring) = RING.lock() {
        ring.record_failure();
    }
}

pub fn stats() -> PerfStats {
    match RING.lock() {
        Ok(ring) => ring.stats(),
        // 锁中毒恢复：返回空统计（埋点链路不应因统计崩溃拖垮抓取）
        Err(_) => Ring::empty_stats(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 竞态根治说明：这些断言只依赖单个 Ring 实例内的样本，与进程级全局 RING
    // 完全解耦——cargo test 多线程并行 / 执行顺序变化均不影响结果。
    // （历史缺陷：曾用全局锁互斥但共享全局缓冲，测试顺序不定时
    // capacity 残留样本致 p95 断言 sample_count 偶发 FAILED。）

    #[test]
    fn p95_nearest_rank_matches_definition() {
        let mut ring = Ring::new();
        // 100 个样本 1..=100ms：p95 = ceil(0.95*100)-1 = 第 94 索引 = 95ms
        for i in 1..=100 {
            ring.record_success(i as f64);
        }
        let s = ring.stats();
        assert_eq!(s.sample_count, 100);
        assert_eq!(s.p95_ms, 95.0);
        assert_eq!(s.p50_ms, 50.0);
        assert_eq!(s.max_ms, 100.0);
        assert!((s.mean_ms - 50.5).abs() < 1e-9);
    }

    #[test]
    fn ring_capacity_evicts_oldest() {
        let mut ring = Ring::new();
        for i in 0..(CAPACITY + 10) {
            ring.record_success(i as f64);
        }
        let s = ring.stats();
        assert_eq!(s.sample_count, CAPACITY);
        assert_eq!(s.last_ms, (CAPACITY + 10 - 1) as f64);
    }

    #[test]
    fn failures_counted_separately() {
        let mut ring = Ring::new();
        ring.record_failure();
        ring.record_failure();
        assert_eq!(ring.stats().failure_count, 2);
    }

    #[test]
    fn clipboard_samples_excluded_from_main_distribution() {
        let mut ring = Ring::new();
        ring.record_success(10.0);
        ring.record_clipboard(500.0);
        let s = ring.stats();
        assert_eq!(s.sample_count, 1);
        assert_eq!(s.p95_ms, 10.0);
        assert_eq!(s.clipboard_sample_count, 1);
        assert_eq!(s.clipboard_mean_ms, 500.0);
    }

    #[test]
    fn empty_ring_reports_zeroed_stats() {
        assert_eq!(Ring::new().stats().sample_count, 0);
        assert_eq!(Ring::new().stats().p95_ms, 0.0);
    }

    /// 全局委托实测：record_* → stats() 通路可用且不 panic（不依赖具体计数，
    /// 其余测试可能已并发写入，只验证类型与有界性）。
    #[test]
    fn global_delegation_smoke() {
        record_success(1.0);
        record_clipboard(1.0);
        record_failure();
        let s = stats();
        assert!(s.p95_ms.is_finite());
        assert!(s.mean_ms.is_finite());
        assert!(s.sample_count <= CAPACITY);
        assert!(s.clipboard_sample_count <= CAPACITY as u64);
    }
}
