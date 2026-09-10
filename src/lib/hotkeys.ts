/**
 * 全局快捷键：前端常量与录制工具。
 * 组合键字符串格式 = tauri-plugin-global-shortcut（global-hotkey crate）解析格式，
 * 大小写不敏感；token 白名单与 Rust 侧 parse_key（global-hotkey hotkey.rs）对齐。
 * 默认值对应 Rust 侧 src-tauri/src/prefs/mod.rs 的 DEFAULT_HOTKEY_*，两处须同步。
 */

export const DEFAULT_HOTKEY_TOGGLE = "ctrl+alt+d";
export const DEFAULT_HOTKEY_SHOW_MAIN = "ctrl+alt+space";
/** OCR 取词（对应 Rust DEFAULT_HOTKEY_OCR_LOOKUP） */
export const DEFAULT_HOTKEY_OCR_LOOKUP = "ctrl+alt+o";

/** 修饰键集合（单独按下不构成组合，等待主键） */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
]);

/** KeyboardEvent.code → 快捷键 token（global-hotkey parse_key 接受的键名，小写） */
const CODE_TO_TOKEN: Record<string, string> = {
  Backquote: "backquote",
  Backslash: "backslash",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
  Comma: "comma",
  Minus: "minus",
  Period: "period",
  Quote: "quote",
  Semicolon: "semicolon",
  Slash: "slash",
  Equal: "equal",
  Space: "space",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "esc",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsubtract",
  NumpadMultiply: "nummultiply",
  NumpadDivide: "numdivide",
  NumpadDecimal: "numdecimal",
  NumpadEnter: "numenter",
};
for (let i = 0; i < 26; i++) {
  CODE_TO_TOKEN[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i);
}
for (let i = 0; i < 10; i++) {
  CODE_TO_TOKEN[`Digit${i}`] = String(i);
}
for (let i = 1; i <= 24; i++) {
  CODE_TO_TOKEN[`F${i}`] = `f${i}`;
}
for (let i = 0; i < 10; i++) {
  CODE_TO_TOKEN[`Numpad${i}`] = `num${i}`;
}

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** KeyboardEvent.code → token；null = 不支持的按键 */
export function codeToToken(code: string): string | null {
  return CODE_TO_TOKEN[code] ?? null;
}

/** 从按键事件构造组合键 token（如 "ctrl+alt+d"）；null = 无主键/不支持的主键 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (isModifierCode(e.code)) return null;
  const key = codeToToken(e.code);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("super");
  parts.push(key);
  return parts.join("+");
}

/** 组合键 token → 展示名（"ctrl+alt+d" → "Ctrl+Alt+D"；"num5" → "Num5"） */
export function formatHotkey(token: string): string {
  return token
    .split("+")
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join("+");
}
