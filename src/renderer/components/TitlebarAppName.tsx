/**
 * @file src/renderer/components/TitlebarAppName.tsx
 * @purpose 标题栏里的应用名,带一个彩蛋:点一下名字,它开心地跳一下,撒出一圈小星星和
 *   小爱心,名字下方冒出一个气泡说"你发现我啦!"。每点一次换一句台词。
 *   纯装饰:不碰数据、设置或 IPC。
 *
 * @关键设计:
 * - 标题栏是拖动区(-webkit-app-region: drag),拖动区收不到点击,所以名字本身设为
 *   no-drag(样式在 material.css)。代价是按住名字不能拖窗口,标题栏其余地方照常能拖。
 * - 气泡和星星用 portal 挂到 body、position: fixed 定位:.titlebar-title 有
 *   overflow: hidden,挂在里面会被裁掉。
 * - 连点会从头重播而不是叠加:每次点击 id 加一,作为 key 让 React 重挂元素,
 *   CSS 动画随之从第一帧开始。
 * - prefers-reduced-motion 时不跳、不撒星星,气泡只淡入淡出(material.css)。
 * - 双击名字不会切最大化:WindowChrome 的双击处理跳过 .titlebar-app-name。
 *
 * @不要在这里做的事:
 * - 不要加声音、系统通知或任何持久化,它只是一个小惊喜
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { tx } from '@shared/i18n';

/** 台词,按点击次数轮换。[中文, English] */
const LINES: ReadonlyArray<readonly [string, string]> = [
  ['你发现我啦!', 'You found me!'],
  ['嘿嘿,被你点到了', 'Hehe, you got me'],
  ['躲猫猫失败 (つ﹏⊂)', 'Peekaboo, caught! (つ﹏⊂)'],
  ['其他条件不变,见到你很开心', 'All else equal, happy to see you'],
  ['再戳一下试试?', 'Poke me again?'],
];

/** 气泡停留时长,与 material.css 里 .easter-bubble 的淡出延迟一致。 */
const SHOW_MS = 2600;

/** 星星与爱心:字符和颜色轮换。颜色取自应用图标的青柠、粉和浅紫。 */
const SPARKLE_GLYPHS = ['✦', '♥', '✧', '★', '♥', '✦', '✧', '♥'];
const SPARKLE_COLORS = ['#c5f07a', '#ff8fc8', '#b9a8ff', '#ffd27a'];

interface Burst {
  id: number;
  /** 名字的左边、水平中心、垂直中心与底边,视口坐标。 */
  left: number;
  centerX: number;
  centerY: number;
  bottom: number;
  line: number;
}

export function TitlebarAppName({ label }: { label: string }): JSX.Element {
  const nameRef = useRef<HTMLSpanElement>(null);
  const clicks = useRef(0);
  const [burst, setBurst] = useState<Burst | null>(null);

  useEffect(() => {
    if (!burst) return;
    const timer = setTimeout(() => setBurst(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [burst]);

  const handleClick = (): void => {
    const rect = nameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const line = clicks.current % LINES.length;
    clicks.current += 1;
    setBurst({
      id: clicks.current,
      left: rect.left,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      bottom: rect.bottom,
      line,
    });
  };

  return (
    <>
      <span
        ref={nameRef}
        key={burst ? `happy-${burst.id}` : 'idle'}
        className={`titlebar-app-name${burst ? ' is-happy' : ''}`}
        onClick={handleClick}
      >
        {label}
      </span>
      {burst && createPortal(<EasterBurst burst={burst} />, document.body)}
    </>
  );
}

function EasterBurst({ burst }: { burst: Burst }): JSX.Element {
  const [zh, en] = LINES[burst.line] ?? (['你发现我啦!', 'You found me!'] as const);
  const bubbleStyle = {
    left: burst.left,
    top: burst.bottom + 10,
    '--tail-x': `${Math.max(14, burst.centerX - burst.left)}px`,
  } as CSSProperties;

  return (
    <div key={burst.id} className="easter-layer">
      {SPARKLE_GLYPHS.map((glyph, i) => {
        // 名字贴着窗口顶边,往上飞的会出窗口,所以只撒向两侧和下方(-27° 到 207°),
        // 距离随序号略有差别,看起来不像死板的一圈。
        const angle = (-0.15 + (i / (SPARKLE_GLYPHS.length - 1)) * 1.3) * Math.PI;
        const distance = 30 + (i % 3) * 10;
        const style = {
          left: burst.centerX,
          top: burst.centerY,
          color: SPARKLE_COLORS[i % SPARKLE_COLORS.length],
          '--dx': `${Math.cos(angle) * distance}px`,
          '--dy': `${Math.sin(angle) * distance}px`,
          '--rot': `${(i % 2 === 0 ? 1 : -1) * (90 + i * 20)}deg`,
          '--delay': `${i * 25}ms`,
        } as CSSProperties;
        return (
          <span key={i} className="easter-sparkle" style={style}>
            {glyph}
          </span>
        );
      })}
      <div className="easter-bubble" style={bubbleStyle} role="status">
        <span className="easter-bubble-text">✨ {tx(zh, en)}</span>
      </div>
    </div>
  );
}
