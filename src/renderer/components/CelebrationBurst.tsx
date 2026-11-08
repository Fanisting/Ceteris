/**
 * @file src/renderer/components/CelebrationBurst.tsx
 * @purpose ADR-027 小庆祝:agent 跑完一轮而用户没在看时,圆点上飞出三颗小星星
 *   (样式随主题,见 celebration-style.ts),0.6 秒左右淡掉,圆点照旧留着等用户看。
 *
 * @关键设计:
 * - 只在 play 从 false 变 true 的那一刻播一次。prev 用当前值初始化,所以标签栏重挂、
 *   窗口刚打开时已经在"未看"状态的圆点不会再撒一次。
 * - 粒子用 portal 挂到 body、position: fixed:标签栏和侧栏都有 overflow 裁切,
 *   挂在圆点里面会被剪掉。坐标取 anchorRef 的视口位置。
 * - 锚点不可见(宽为 0,例如折叠的文件夹)时不播。
 * - 不订阅 store:开关和主题由父级传入。侧栏的 SessionItem 刻意不调 useAppState
 *   (Sidebar.tsx "抖动源 D"),这里订阅会让每一行跟着任何状态变化重渲。
 * - 设置 appearance.celebrations=false 时不播;系统开启减少动态效果时
 *   celebrations.css 隐藏粒子,只留下圆点本身。
 *
 * @不要在这里做的事:
 * - 不要加声音、系统通知、抢焦点或任何持久化
 * - 不要判断"跑完了没看",那是 store 的 unseenDoneSessionIds(ADR-021)
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { celebrationStyleFor, type CelebrationStyle } from '../celebration-style';

interface Burst {
  id: number;
  x: number;
  y: number;
  style: CelebrationStyle;
}

/** 粒子停留时长,比 celebrations.css 里最长的动画(延迟 + 时长)略长。 */
const BURST_MS = 1000;

/** 三颗粒子:往左上、正上、右上飞(度,0 = 向右,-90 = 向上)。 */
const ANGLES = [-150, -90, -30];

export function CelebrationBurst({
  play,
  anchorRef,
  enabled,
  themeId,
}: {
  /** 圆点是否亮着;只在 false → true 的那一刻播。 */
  play: boolean;
  /** 粒子从它的中心飞出。 */
  anchorRef: RefObject<HTMLElement>;
  /** settings.appearance.celebrations */
  enabled: boolean;
  /** settings.appearance.theme,决定样式 */
  themeId: string | undefined;
}): JSX.Element | null {
  const prev = useRef(play);
  const counter = useRef(0);
  const [burst, setBurst] = useState<Burst | null>(null);

  useEffect(() => {
    const was = prev.current;
    prev.current = play;
    if (!play || was || !enabled) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    counter.current += 1;
    setBurst({
      id: counter.current,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      style: celebrationStyleFor(themeId),
    });
  }, [play, enabled, themeId, anchorRef]);

  useEffect(() => {
    if (!burst) return;
    const timer = setTimeout(() => setBurst(null), BURST_MS);
    return () => clearTimeout(timer);
  }, [burst]);

  if (!burst) return null;
  return createPortal(<BurstLayer key={burst.id} burst={burst} />, document.body);
}

function BurstLayer({ burst }: { burst: Burst }): JSX.Element {
  const layerStyle: CSSProperties = { left: burst.x, top: burst.y };
  return (
    <div className={`cheer-layer cheer-${burst.style}`} style={layerStyle} aria-hidden="true">
      {burst.style === 'shimmer' && <span className="cheer-ring" />}
      {burst.style === 'check' && (
        <span className="cheer-check">
          <CheckGlyph />
        </span>
      )}
      {(burst.style === 'sparkle' || burst.style === 'heart' || burst.style === 'petal') &&
        ANGLES.map((deg, i) => {
          const rad = (deg * Math.PI) / 180;
          // 中间那颗飞得远一点,三颗不排成死板的一圈。
          const distance = i === 1 ? 18 : 14;
          const style = {
            '--dx': `${(Math.cos(rad) * distance).toFixed(1)}px`,
            '--dy': `${(Math.sin(rad) * distance).toFixed(1)}px`,
            '--rot': `${burst.style === 'petal' ? 60 + i * 50 : 0}deg`,
            '--delay': `${i * 40}ms`,
          } as CSSProperties;
          return (
            <span key={i} className="cheer-particle" style={style}>
              <ParticleGlyph style={burst.style} />
            </span>
          );
        })}
    </div>
  );
}

function ParticleGlyph({ style }: { style: CelebrationStyle }): JSX.Element {
  if (style === 'heart') {
    return (
      <svg viewBox="0 0 10 10">
        <path d="M5 9S.5 6.2.5 3.3A2.3 2.3 0 0 1 5 2.4a2.3 2.3 0 0 1 4.5.9C9.5 6.2 5 9 5 9z" />
      </svg>
    );
  }
  if (style === 'petal') {
    return (
      <svg viewBox="0 0 10 10">
        <ellipse cx="5" cy="5" rx="2.4" ry="4.6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 10 10">
      <path d="M5 0l1.1 3.9L10 5 6.1 6.1 5 10 3.9 6.1 0 5l3.9-1.1z" />
    </svg>
  );
}

function CheckGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12">
      <path
        d="M2.5 6.4l2.3 2.3 4.7-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
