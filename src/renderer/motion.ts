/**
 * @file src/renderer/motion.ts
 * @purpose 退场动画的共用工具。入场动画全在 CSS(styles/motion.css),元素一挂载
 *   就播放;退场不一样,React 卸载元素的同时它就从屏幕上消失了,所以需要让它
 *   多留一小会儿,播完淡出再真正卸载。
 *
 * @关键设计:
 * - 退场期间元素只是"残影":调用方给它加 .exiting 类,CSS 里设 pointer-events:
 *   none,键盘监听也只认真实状态,所以残影不吃点击、不吃按键、不进 overlay 栈。
 * - 时长与 motion.css 的 --md-duration-short3 一致(150ms)。改一边记得改另一边。
 * - 系统开了"减少动效"时不留残影,立刻卸载。
 *
 * @不要在这里做的事:
 * - 不要给终端相关的东西加退场:xterm 画布和终端焦点永远不能被动画拖慢。
 *
 * @对应文档章节:软件定义书.md 5.1.9(外观)
 */
import { useEffect, useState } from 'react';

/** 退场动画时长,ms。与 motion.css 里 .exiting 规则用的 short3 一致。 */
export const MOTION_EXIT_MS = 150;

/** 用户在系统里开了"减少动效"。读取失败时按没开处理。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 让一个"可能为 null 的显示对象"在变成 null 之后再多显示 exitMs 毫秒。
 *
 * @param value 当前真实状态,null 表示应该关闭
 * @param exitMs 残影保留时长
 * @returns shown:用来渲染的对象(退场期间是最后一个非 null 值);
 *   exiting:正在退场,调用方据此加 .exiting 类
 *
 * @副作用:退场期间起一个 setTimeout,结束时清掉残影。value 在退场中途又变成
 *   非 null(紧接着打开下一个对话框)时,直接显示新值,计时器作废。
 */
export function usePresence<T>(
  value: T | null,
  exitMs: number = MOTION_EXIT_MS,
): { shown: T | null; exiting: boolean } {
  const [held, setHeld] = useState<T | null>(value);
  // 渲染期间同步记下最新的非 null 值(React 允许组件在渲染里更新自己的 state)。
  // 放进 effect 会晚一次提交,关闭那一帧就拿不到要显示的内容。
  if (value !== null && value !== held) setHeld(value);
  const exiting = value === null && held !== null;

  useEffect(() => {
    if (!exiting) return undefined;
    const timer = setTimeout(() => setHeld(null), prefersReducedMotion() ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [exiting, exitMs]);

  return { shown: value ?? held, exiting };
}
