//! 浮标定位：纯函数移植 pickdict `SelectionService.calculateToolbarPosition` +
//! `processTextSelection` 的方位判定主干（行为基线，AGPL 文件只读对照、不复制）。
//!
//! 输入输出全部为 Windows 物理像素（hook 坐标与 UIA 包围盒同坐标系，Tauri 侧用
//! `Position::Physical` 直接消费），与 pickdict 的 DIP 换算路径等效但少一次转换。
//!
//! 方位语义（与 pickdict 一致）：
//! - 双击选词 → `bottomMiddle`，锚点 = 词行底 + 4
//! - 同行拖拽 → 按拖拽方向 `bottomLeft`（正向）/ `bottomRight`（反向），锚点 = 行底 + 4
//! - 跨行拖拽 → 向下 `bottomLeft`（终点行右下 + 4）/ 向上 `topRight`（起点行左上 − 4）
//! - 无 UIA 包围盒时退回鼠标坐标路径（+16 位移，同 MOUSE_SINGLE/DUAL）
//! - 最终按参考点所在显示器工作区钳制；越上/越下时 ±32 微调

/// 物理像素矩形（左上角 + 尺寸）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl PhysRect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// pickdict 全集 9 方位（spike 路径只用 TopRight/Bottom*，其余保留以对齐 `place` 语义完整性）
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    TopLeft,
    TopRight,
    TopMiddle,
    BottomLeft,
    BottomRight,
    BottomMiddle,
    MiddleLeft,
    MiddleRight,
    Center,
}

#[derive(Debug, Clone, Copy)]
pub struct Anchor {
    pub point: Point,
    pub orientation: Orientation,
}

/// 拖拽/双击判定阈值（物理像素）：
/// - 双击位移上限（pickdict 为精确相等；LL 钩子下按系统双击矩形判定，见 hook.rs）
/// - 跨行判定：|dy| > 14 视为不同行（pickdict 同款魔数）
pub const MULTILINE_DY_THRESHOLD: i32 = 14;
pub const BELOW_MOUSE_OFFSET: i32 = 16;
pub const BELOW_RECT_OFFSET: i32 = 4;
pub const ABOVE_RECT_OFFSET: i32 = 4;
pub const EDGE_NUDGE: i32 = 32;

/// 方位判定。`rects` 为 UIA TextRange 行包围盒（阅读序，可空）；
/// `mouse_start`/`mouse_end` 为钩子记录的按下/释放位置（物理）。
pub fn pick_anchor(
    mouse_start: Point,
    mouse_end: Point,
    rects: &[PhysRect],
    is_double_click: bool,
) -> Anchor {
    let dy = mouse_end.y - mouse_start.y;
    let dx = mouse_end.x - mouse_start.x;

    // 无包围盒：退回鼠标坐标路径（pickdict MOUSE_SINGLE / MOUSE_DUAL）
    let Some(first) = rects.first() else {
        return mouse_based_anchor(mouse_start, mouse_end, is_double_click);
    };
    let last = rects[rects.len() - 1];
    let same_line = rects.len() == 1 || first.y == last.y;

    if is_double_click && same_line {
        // 双击选词：词下方居中
        return Anchor {
            point: Point {
                x: mouse_end.x,
                y: last.bottom() + BELOW_RECT_OFFSET,
            },
            orientation: Orientation::BottomMiddle,
        };
    }

    if same_line {
        if dx >= 0 {
            Anchor {
                point: Point {
                    x: last.right(),
                    y: last.bottom() + BELOW_RECT_OFFSET,
                },
                orientation: Orientation::BottomLeft,
            }
        } else {
            Anchor {
                point: Point {
                    x: first.x,
                    y: first.bottom() + BELOW_RECT_OFFSET,
                },
                orientation: Orientation::BottomRight,
            }
        }
    } else if dy > 0 {
        // 向下选：终点行（阅读序最后一行）右下角
        Anchor {
            point: Point {
                x: last.right(),
                y: last.bottom() + BELOW_RECT_OFFSET,
            },
            orientation: Orientation::BottomLeft,
        }
    } else {
        // 向上选：起点行（阅读序最后一行，视觉在下）左上角
        Anchor {
            point: Point {
                x: last.x,
                y: last.y - ABOVE_RECT_OFFSET,
            },
            orientation: Orientation::TopRight,
        }
    }
}

/// 无 UIA 包围盒时的鼠标路径（pickdict MOUSE_SINGLE / MOUSE_DUAL）
fn mouse_based_anchor(mouse_start: Point, mouse_end: Point, is_double_click: bool) -> Anchor {
    if is_double_click {
        return Anchor {
            point: Point {
                x: mouse_end.x,
                y: mouse_end.y + BELOW_MOUSE_OFFSET,
            },
            orientation: Orientation::BottomMiddle,
        };
    }
    let dy = mouse_end.y - mouse_start.y;
    let dx = mouse_end.x - mouse_start.x;
    if dy.abs() > MULTILINE_DY_THRESHOLD {
        if dy > 0 {
            Anchor {
                point: Point {
                    x: mouse_end.x,
                    y: mouse_end.y + BELOW_MOUSE_OFFSET,
                },
                orientation: Orientation::BottomLeft,
            }
        } else {
            Anchor {
                point: Point {
                    x: mouse_end.x,
                    y: mouse_end.y - BELOW_MOUSE_OFFSET,
                },
                orientation: Orientation::TopRight,
            }
        }
    } else if dx > 0 {
        Anchor {
            point: Point {
                x: mouse_end.x,
                y: mouse_end.y.max(mouse_start.y) + BELOW_MOUSE_OFFSET,
            },
            orientation: Orientation::BottomLeft,
        }
    } else {
        Anchor {
            point: Point {
                x: mouse_end.x,
                y: mouse_end.y.min(mouse_start.y) + BELOW_MOUSE_OFFSET,
            },
            orientation: Orientation::BottomRight,
        }
    }
}

/// 锚点 + 方位 → 浮标左上角坐标，并按参考点所在显示器工作区钳制
/// （移植 `calculateToolbarPosition`：先按方位展开，再钳制，越上/越下 ±32 微调）
pub fn place(anchor: Anchor, toolbar: (i32, i32), work_area: PhysRect) -> Point {
    let (tw, th) = toolbar;
    let mut pos = match anchor.orientation {
        Orientation::TopLeft => Point {
            x: anchor.point.x - tw,
            y: anchor.point.y - th,
        },
        Orientation::TopRight => Point {
            x: anchor.point.x,
            y: anchor.point.y - th,
        },
        Orientation::TopMiddle => Point {
            x: anchor.point.x - tw / 2,
            y: anchor.point.y - th,
        },
        Orientation::BottomLeft => Point {
            x: anchor.point.x - tw,
            y: anchor.point.y,
        },
        Orientation::BottomRight => Point {
            x: anchor.point.x,
            y: anchor.point.y,
        },
        Orientation::BottomMiddle => Point {
            x: anchor.point.x - tw / 2,
            y: anchor.point.y,
        },
        Orientation::MiddleLeft => Point {
            x: anchor.point.x - tw,
            y: anchor.point.y - th / 2,
        },
        Orientation::MiddleRight => Point {
            x: anchor.point.x,
            y: anchor.point.y - th / 2,
        },
        Orientation::Center => Point {
            x: anchor.point.x - tw / 2,
            y: anchor.point.y - th / 2,
        },
    };

    let exceeds_top = pos.y < work_area.y;
    let exceeds_bottom = pos.y > work_area.y + work_area.h - th;

    pos.x = pos.x.max(work_area.x).min(work_area.x + work_area.w - tw);
    pos.y = pos.y.max(work_area.y).min(work_area.y + work_area.h - th);

    if exceeds_top {
        pos.y += EDGE_NUDGE;
    }
    if exceeds_bottom {
        pos.y -= EDGE_NUDGE;
    }
    pos
}

/// 动作面板与浮标的间距（物理像素）
pub const PANEL_GAP: i32 = 8;

/// 动作面板定位：默认浮标左缘对齐 + 浮标下方 PANEL_GAP；
/// 底部空间不足 → 面板底边贴浮标上方（PANEL_GAP）；无浮标参考时用锚点坐标；
/// 最终整体钳制进工作区（面板常贴边显示，不做浮标的 ±32 微调）。
pub fn place_panel(
    anchor: Point,
    panel: (i32, i32),
    toolbar: Option<PhysRect>,
    work_area: PhysRect,
) -> Point {
    let (pw, ph) = panel;
    let (mut x, mut y) = match toolbar {
        Some(t) => (t.x, t.bottom() + PANEL_GAP),
        None => (anchor.x, anchor.y + PANEL_GAP),
    };
    if let Some(t) = toolbar {
        if y + ph > work_area.bottom() {
            y = t.y - ph - PANEL_GAP;
        }
    }
    x = x.max(work_area.x).min((work_area.x + work_area.w - pw).max(work_area.x));
    y = y.max(work_area.y).min((work_area.y + work_area.h - ph).max(work_area.y));
    Point { x, y }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TB: (i32, i32) = (320, 48);

    fn rect(x: i32, y: i32, w: i32, h: i32) -> PhysRect {
        PhysRect { x, y, w, h }
    }

    fn work(x: i32, y: i32, w: i32, h: i32) -> PhysRect {
        rect(x, y, w, h)
    }

    #[test]
    fn double_click_centers_below_word_row() {
        // 词行 (100..200, y=50..80)，双击点 (150, 65)
        let rects = [rect(100, 50, 100, 30)];
        let a = pick_anchor(
            Point { x: 150, y: 65 },
            Point { x: 150, y: 65 },
            &rects,
            true,
        );
        assert_eq!(a.orientation, Orientation::BottomMiddle);
        assert_eq!(a.point, Point { x: 150, y: 84 });
        // bottomMiddle：浮标水平居中于锚点；锚点近左缘 → 钳回工作区内
        let p = place(a, TB, work(0, 0, 1920, 1040));
        assert_eq!(p, Point { x: 0, y: 84 });
    }

    #[test]
    fn same_line_drag_ltr_anchors_right_edge() {
        let rects = [rect(100, 50, 300, 30)];
        let a = pick_anchor(
            Point { x: 100, y: 65 },
            Point { x: 400, y: 65 },
            &rects,
            false,
        );
        assert_eq!(a.orientation, Orientation::BottomLeft);
        assert_eq!(a.point, Point { x: 400, y: 84 });
    }

    #[test]
    fn same_line_drag_rtl_anchors_left_edge() {
        let rects = [rect(100, 50, 300, 30)];
        let a = pick_anchor(
            Point { x: 400, y: 65 },
            Point { x: 100, y: 65 },
            &rects,
            false,
        );
        assert_eq!(a.orientation, Orientation::BottomRight);
        assert_eq!(a.point, Point { x: 100, y: 84 });
    }

    #[test]
    fn multiline_downward_anchors_end_row() {
        // 两行，向下拖（start 在上行，end 在下行）
        let rects = [rect(100, 50, 300, 30), rect(100, 90, 200, 30)];
        let a = pick_anchor(
            Point { x: 120, y: 60 },
            Point { x: 250, y: 100 },
            &rects,
            false,
        );
        assert_eq!(a.orientation, Orientation::BottomLeft);
        assert_eq!(a.point, Point { x: 300, y: 124 });
    }

    #[test]
    fn multiline_upward_anchors_start_row_top() {
        // 向上拖：起点行视觉在下 = 阅读序最后一行
        let rects = [rect(100, 50, 300, 30), rect(100, 90, 200, 30)];
        let a = pick_anchor(
            Point { x: 250, y: 100 },
            Point { x: 120, y: 60 },
            &rects,
            false,
        );
        assert_eq!(a.orientation, Orientation::TopRight);
        assert_eq!(a.point, Point { x: 100, y: 86 });
    }

    #[test]
    fn no_rects_falls_back_to_mouse_path() {
        let a = pick_anchor(
            Point { x: 500, y: 300 },
            Point { x: 600, y: 308 },
            &[],
            false,
        );
        // 同行（dy=8 ≤ 14）、正向：bottomLeft @ (600, max(308,300)+16)
        assert_eq!(a.orientation, Orientation::BottomLeft);
        assert_eq!(a.point, Point { x: 600, y: 324 });
    }

    #[test]
    fn clamps_into_work_area() {
        // 锚点在屏幕右缘外：钳回右边界内
        let a = Anchor {
            point: Point { x: 1900, y: 500 },
            orientation: Orientation::BottomRight,
        };
        let p = place(a, TB, work(0, 0, 1920, 1040));
        assert_eq!(p.x, 1920 - 320);
        assert_eq!(p.y, 500);
    }

    #[test]
    fn nudges_down_when_exceeds_top() {
        // topRight 于屏幕顶：先越顶 → 钳到顶后 +32
        let a = Anchor {
            point: Point { x: 800, y: 20 },
            orientation: Orientation::TopRight,
        };
        let p = place(a, TB, work(0, 0, 1920, 1040));
        assert_eq!(p.y, 32);
        assert_eq!(p.x, 800);
    }

    #[test]
    fn nudges_up_when_exceeds_bottom() {
        let a = Anchor {
            point: Point { x: 800, y: 1030 },
            orientation: Orientation::BottomMiddle,
        };
        let p = place(a, TB, work(0, 0, 1920, 1040));
        // 未钳前 y=1030 > 1040-48=992 → 越底；钳到 992 后 −32 = 960
        assert_eq!(p.y, 960);
    }

    #[test]
    fn panel_below_toolbar() {
        let t = rect(100, 500, 320, 48);
        let p = place_panel(Point { x: 150, y: 520 }, (480, 400), Some(t), work(0, 0, 1920, 1040));
        // 浮标左缘对齐 + 浮标底 + 8
        assert_eq!(p, Point { x: 100, y: 556 });
    }

    #[test]
    fn panel_flips_above_toolbar_when_bottom_exceeds() {
        let t = rect(100, 800, 320, 48);
        let p = place_panel(Point { x: 150, y: 820 }, (480, 400), Some(t), work(0, 0, 1920, 1040));
        // 下方放不下（856+400 > 1040）→ 底边贴浮标上方
        assert_eq!(p, Point { x: 100, y: 392 });
    }

    #[test]
    fn panel_clamps_without_toolbar() {
        let p = place_panel(Point { x: 1800, y: 300 }, (480, 400), None, work(0, 0, 1920, 1040));
        // 水平钳进工作区：1920-480=1440
        assert_eq!(p, Point { x: 1440, y: 308 });
    }

    #[test]
    fn panel_degenerate_work_area_stays_inside() {
        // 工作区小于面板：钳制不得产生负坐标
        let p = place_panel(Point { x: -50, y: -50 }, (480, 400), None, work(0, 0, 300, 200));
        assert_eq!(p, Point { x: 0, y: 0 });
    }
}
