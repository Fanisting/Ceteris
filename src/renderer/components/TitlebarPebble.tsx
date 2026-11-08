/**
 * @file src/renderer/components/TitlebarPebble.tsx
 * @purpose ADR-027 标题栏小石子:一个 16px 的小圆团,按所有 session 的 agent 状态换表情。
 *   全部空闲时闭眼打盹,有 agent 在干活(agentPhase=working)时睁眼,
 *   有 agent 跑完一轮(working → done)时笑两秒,再回到前两种之一。
 *
 * @关键设计:
 * - 默认关(appearance.pebble=false),appearance.celebrations=false 时也不显示。
 * - 看所有 session,不只本窗口持有的:侧栏本来就列出全部 session。
 * - "跑完"在这里自己比前后两次的 agentPhase,不用 unseenDoneSessionIds:
 *   正在看的那个 session 跑完,小石子也笑。
 * - 两个比较都用 useLayoutEffect:working 刚变 done 的那一帧还没算出"笑",
 *   用普通 useEffect 会先画一帧打盹再笑。
 * - pointer-events: none,不挡标题栏拖动,也不接点击。
 * - 系统减少动态效果时不呼吸、不跳,表情照换(celebrations.css)。
 *
 * @不要在这里做的事:
 * - 不要加点击交互、气泡或声音,它只是一个安静的小伙伴
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { AgentPhase } from '@shared/types';
import { useAppState } from '../store';

/** 笑的时长。 */
const SMILE_MS = 2000;

type Mood = 'doze' | 'watch' | 'smile';

export function TitlebarPebble(): JSX.Element | null {
  const state = useAppState();
  const a = state.settings.appearance;
  const show = (a?.celebrations ?? true) && (a?.pebble ?? false);

  const prevPhases = useRef<Map<string, AgentPhase | null>>(new Map());
  // 每次有 agent 跑完就加一,作为计时器的依赖:笑的过程中又有一个跑完,从头再笑两秒。
  const [smileId, setSmileId] = useState(0);
  const [smiling, setSmiling] = useState(false);

  let working = false;
  for (const s of state.sessions.values()) {
    if (s.agentPhase === 'working') working = true;
  }

  useLayoutEffect(() => {
    const prev = prevPhases.current;
    const next = new Map<string, AgentPhase | null>();
    let finished = false;
    for (const s of state.sessions.values()) {
      const phase = s.agentPhase ?? null;
      if (phase === 'done' && prev.get(s.id) === 'working') finished = true;
      next.set(s.id, phase);
    }
    prevPhases.current = next;
    if (finished) setSmileId((n) => n + 1);
  }, [state.sessions]);

  useLayoutEffect(() => {
    if (smileId === 0) return;
    setSmiling(true);
    const timer = setTimeout(() => setSmiling(false), SMILE_MS);
    return () => clearTimeout(timer);
  }, [smileId]);

  if (!show) return null;
  const mood: Mood = smiling ? 'smile' : working ? 'watch' : 'doze';
  return (
    <span className="cheer-pebble-slot titlebar-drag" aria-hidden="true">
      <svg className="cheer-pebble" data-mood={mood} viewBox="0 0 16 16">
        <path
          className="cheer-pebble-body"
          d="M8 2.2c3.6 0 6.4 3 6.4 6.6 0 3.2-2.8 5-6.4 5S1.6 12 1.6 8.8C1.6 5.2 4.4 2.2 8 2.2z"
        />
        <g className="cheer-pebble-eyes closed">
          <path d="M4.8 8.6h1.8M9.4 8.6h1.8" />
        </g>
        <g className="cheer-pebble-eyes open">
          <circle cx="5.9" cy="8.2" r="1.1" />
          <circle cx="10.3" cy="8.2" r="1.1" />
        </g>
        <g className="cheer-pebble-eyes happy">
          <path d="M4.8 8.9l.9-1 .9 1M9.4 8.9l.9-1 .9 1" />
        </g>
        <circle className="cheer-pebble-blush" cx="4.2" cy="10.4" r="1" />
        <circle className="cheer-pebble-blush" cx="11.8" cy="10.4" r="1" />
      </svg>
    </span>
  );
}
