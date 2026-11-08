/**
 * @file src/shared/coordinator-prompts.ts
 * @purpose The prompts the coordinator tour (ADR-024) pastes into agent tabs: a first job for
 *   the Coordinator and the brief for a Fintuner. Each has a Chinese and an English version,
 *   written for that reader rather than translated word for word; the interface language picks.
 *
 * @关键设计:
 * - Pasted, never sent: the tour types the text and the user presses Enter. Reading chat history
 *   costs tokens, and a first job should be the user's call.
 * - One line each, so an agent does not fold it into a "[Pasted text]" block the user cannot read.
 * - They name agents generically: the user may run Claude Code, Codex or another agent.
 *
 * @不要在这里做的事:
 * - 不要在这里决定何时粘贴 (那是 CoordinatorTour.tsx)
 */

export interface LocalizedPrompt {
  zh: string;
  en: string;
}

/** A first job for the Coordinator, typed into its tab from the "Give it a job" step. */
export const COORDINATOR_JOB_PROMPT: LocalizedPrompt = {
  zh: '在这个文件夹开两个新的 agent 标签:一个给最近改过的代码补测试,一个跑一遍测试并修掉失败的。盯着它们,两个都做完后把结果汇总给我。',
  en: 'Open two new agent tabs in this folder: one adds tests for the code changed most recently, the other runs the tests and fixes what fails. Keep an eye on both and give me a summary when they are done.',
};

/** The Fintuner's brief, typed into its tab once the agent has started. */
export const FINTUNER_PROMPT: LocalizedPrompt = {
  zh: '你是这个项目的 Fintuner。读这个文件夹最近的 agent 对话记录(Claude Code 在 ~/.claude/projects,Codex 在 ~/.codex/sessions,其他 agent 看它自己的历史目录),找出三类问题:哪里浪费了时间或 token;哪些步骤可以合并,或交给 Coordinator 自动做;哪些问题反复来问我,其实可以定成规则。给我一份按收益排序的改进清单,每条写清楚具体怎么改。',
  en: "You are this project's Fintuner. Read the recent agent chat history for this folder (Claude Code keeps it under ~/.claude/projects, Codex under ~/.codex/sessions, other agents in their own history folder) and look for three things: where time or tokens went to waste; which steps could be merged or handed to the Coordinator; and which questions keep coming back to me and could become rules. Give me a list of improvements ranked by payoff, each saying exactly what to change.",
};
