/**
 * 查词会话导航栈（词条内词索引 + 前进/后退导航）。
 * cursor 模型（同浏览器语义）：back/current/forward 三段——任何跳词
 * （entry:// 内链 / 帧内取词 / 历史点击 / 输入框新查询）把 current 压入 back
 * 并清空 forward（开新分支）；后退/前进只在三段间移动 cursor。
 * 纯函数便于 node 直测（test/wordnav.mjs）；React 绑定用 useWordNav。
 */

import { useCallback, useState } from "react";

export interface WordNavState {
  back: string[];
  current: string;
  forward: string[];
}

/** 栈深上限（长会话防无限增长，淘汰最旧） */
const MAX_STACK = 100;

/** 跳词入栈：空词/同词幂等；forward 清空（开新分支，浏览器语义） */
export function pushWord(state: WordNavState, w: string): WordNavState {
  const t = w.trim();
  if (!t || t === state.current) return state;
  return {
    back: state.current ? [...state.back, state.current].slice(-MAX_STACK) : state.back,
    current: t,
    forward: [],
  };
}

export function canGoBack(state: WordNavState): boolean {
  return state.back.length > 0;
}

export function canGoForward(state: WordNavState): boolean {
  return state.forward.length > 0;
}

/** 后退：current 让位给 back 尾部，自身进 forward 队首（栈空返回原 state） */
export function goBackWord(state: WordNavState): WordNavState {
  if (!state.back.length) return state;
  return {
    back: state.back.slice(0, -1),
    current: state.back[state.back.length - 1],
    forward: [state.current, ...state.forward].slice(0, MAX_STACK),
  };
}

/** 前进：current 压回 back，取 forward 队首（栈空返回原 state） */
export function goForwardWord(state: WordNavState): WordNavState {
  if (!state.forward.length) return state;
  return {
    back: [...state.back, state.current].slice(-MAX_STACK),
    current: state.forward[0],
    forward: state.forward.slice(1),
  };
}

/** 新会话重置（划词面板 per-session reset 语义：新划词不带上一会话历史） */
export function resetWordNav(w: string): WordNavState {
  return { back: [], current: w, forward: [] };
}

/**
 * React 绑定：以返回的 word 作为查词词头单一事实源（DictionaryTab 用法）。
 * navigate = 跳词入栈；back/forward = cursor 移动（栈空时 no-op）。
 */
export function useWordNav(initial = "") {
  const [nav, setNav] = useState<WordNavState>(() => resetWordNav(initial));
  const navigate = useCallback((w: string) => setNav((s) => pushWord(s, w)), []);
  const back = useCallback(() => setNav(goBackWord), []);
  const forward = useCallback(() => setNav(goForwardWord), []);
  return {
    word: nav.current,
    canBack: canGoBack(nav),
    canForward: canGoForward(nav),
    navigate,
    back,
    forward,
  };
}
