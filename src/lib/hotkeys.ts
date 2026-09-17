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

/** 可打印字符主键（按下即向目标应用输入字符）：字母 / 数字 / 标点 / 空格 */
const PRINTABLE_TOKENS = new Set<string>(["space"]);
for (const t of [
  "backquote",
  "backslash",
  "bracketleft",
  "bracketright",
  "comma",
  "equal",
  "minus",
  "period",
  "quote",
  "semicolon",
  "slash",
]) {
  PRINTABLE_TOKENS.add(t);
}
for (let i = 0; i < 26; i++) PRINTABLE_TOKENS.add(String.fromCharCode(97 + i));
for (let i = 0; i < 10; i++) PRINTABLE_TOKENS.add(String(i));

/** 组合键是否会把字符打进当前应用：无 Ctrl/Alt 且主键可打印。
 *  全局快捷键之外按键照常送达前台窗口——Shift+W 这类组合在可编辑处会插入
 *  字符并覆盖选区（实测：快捷键页录制 Shift+W 后被覆盖的正是待查词文本）。 */
export function typingRisk(token: string): boolean {
  const parts = token.split("+").filter(Boolean);
  const main = parts[parts.length - 1] ?? "";
  // Ctrl/Alt 组合不进字符；Win 组合由系统接管（Win+R 等不落字符、且多半已被占用）
  const guarded = parts
    .slice(0, -1)
    .some((m) => m === "ctrl" || m === "alt" || m === "super");
  if (guarded) return false;
  return PRINTABLE_TOKENS.has(main);
}

/** 录制/展示时的告警文案；null = 无风险 */
export function typingRiskWarning(token: string): string | null {
  if (!token || !typingRisk(token)) return null;
  return `${formatHotkey(token)} 会向当前应用输入字符（可编辑处会覆盖选区），建议改用含 Ctrl 或 Alt 的组合`;
}

/** 组合键 token → 展示名（"ctrl+alt+d" → "Ctrl+Alt+D"；"num5" → "Num5"） */
export function formatHotkey(token: string): string {
  return token
    .split("+")
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join("+");
}
