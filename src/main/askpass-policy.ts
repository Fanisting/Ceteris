/**
 * @file src/main/askpass-policy.ts
 * @purpose 决定 ssh 登录时的一条提示怎么回答:自动填保存的密码、拒绝(后台连接不能弹窗)、
 *   还是问用户。纯函数,sftp-client.ts 调用。
 *
 * @关键设计:
 * - 提示的种类只能从文本猜。OpenSSH 不把"是否回显"告诉 askpass,SSH_ASKPASS_PROMPT 也只在
 *   ssh-agent 的确认里才设。文案是 OpenSSH 和 PAM 模块的固定英文,不随系统语言变化。
 * - "Passcode" 不是 "password":Duo 的提示是 "Passcode or option (1-3): ",要是把保存的密码
 *   填进去,登录就失败了,还白白消耗一次 Duo 请求。
 * - 保存的密码只填一次。第二次再问密码说明密码错了,继续填只会把账号锁掉,这时交给用户。
 * - 后台轮询发起的连接不允许弹窗:用户没有操作,凭空弹出一个要密码的框既吓人又容易被
 *   钓鱼模仿。这种连接遇到提示直接断开,等用户主动操作再以交互方式连。
 *
 * @对应文档章节: 软件定义书.md 14.9
 *
 * @不要在这里做的事:
 * - 不要在这里弹窗或碰进程,这里只做判断
 */

export type PromptKind = 'password' | 'passphrase' | 'host-key' | 'confirm' | 'text';

export type AnswerDecision =
  /** 直接回答,用户看不到 */
  | { action: 'answer'; value: string }
  /** 这次连接不能问用户,断开 */
  | { action: 'deny' }
  /** 问用户。input 决定输入框:secret 不回显,text 回显,confirm 是 yes / no */
  | { action: 'ask'; input: 'secret' | 'text' | 'confirm' };

export interface AnswerContext {
  /** profile 里保存的明文密码,没有则 undefined */
  savedPassword?: string | undefined;
  /** 这条连接是否已经自动填过一次密码 */
  passwordUsed: boolean;
  /** 这条连接是否由用户的操作发起,允许弹窗 */
  interactive: boolean;
}

/**
 * 判断提示的种类。
 *
 * @param prompt ssh 传给 askpass 的提示
 * @param hint ssh 的 SSH_ASKPASS_PROMPT,通常为 null
 */
export function classifyPrompt(prompt: string, hint: string | null): PromptKind {
  if (hint === 'confirm') return 'confirm';
  if (/\(yes\/no/i.test(prompt)) return 'host-key';
  if (/passphrase/i.test(prompt)) return 'passphrase';
  // 先排除 passcode,它含 "pass" 但不是密码
  if (/passcode/i.test(prompt)) return 'text';
  if (/password/i.test(prompt)) return 'password';
  return 'text';
}

/** 决定怎么回答。规则见文件头。 */
export function decideAnswer(kind: PromptKind, context: AnswerContext): AnswerDecision {
  if (kind === 'password' && context.savedPassword && !context.passwordUsed) {
    return { action: 'answer', value: context.savedPassword };
  }
  if (!context.interactive) return { action: 'deny' };
  if (kind === 'host-key' || kind === 'confirm') return { action: 'ask', input: 'confirm' };
  if (kind === 'password' || kind === 'passphrase') return { action: 'ask', input: 'secret' };
  return { action: 'ask', input: 'text' };
}
