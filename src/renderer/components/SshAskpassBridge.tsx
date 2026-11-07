/**
 * @file src/renderer/components/SshAskpassBridge.tsx
 * @purpose 后台 SFTP 连接的 ssh 需要用户回答时(密码 / Duo 验证码 / 主机密钥确认),
 *   把 main 发来的提示弹成 modal,再把答案送回去。
 *
 * @关键设计:
 * - 复用 ModalProvider 的 confirm / prompt,不另画对话框。secret 用 password 输入框,
 *   text 回显(Duo 的 "1" 或六位验证码),confirm 是 yes / no 两个按钮。
 * - modal 正文 = ssh 之前打到 stderr 的说明(比如 Duo 的选项菜单)+ 提示本身,
 *   用户看到的和在终端里登录时一样。
 * - main 说这条提示不再需要答案(ssh 断了、超时)时收起 modal,否则用户会对着一个
 *   已经没人等的框输入。
 * - 提示是串行的:ssh 一次只问一个问题,ModalProvider 也一次只开一个。
 *
 * @对应文档章节: 软件定义书.md 14.9
 *
 * @不要在这里做的事:
 * - 不要缓存或记住答案,密码由 main 的 profile 管理
 */
import { useEffect, useRef } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type AskpassAnswerPayload,
  type AskpassPromptPayload,
} from '@shared/protocol';
import { useTranslation } from './LanguageProvider';
import { useModal } from './Modal';

export function SshAskpassBridge(): null {
  const modal = useModal();
  const { t } = useTranslation();
  const currentPromptRef = useRef<string | null>(null);

  useEffect(() => {
    const offPrompt = window.api.on<AskpassPromptPayload>(
      EVENT_CHANNELS.SSH_ASKPASS_PROMPT,
      async (payload) => {
        currentPromptRef.current = payload.promptId;
        const title = t('askpass.title', { name: payload.profileName });
        const message = [payload.detail, payload.prompt].filter((s) => s.length > 0).join('\n');
        let answer: string | null;
        if (payload.kind === 'confirm') {
          const yes = await modal.confirm({
            title,
            message,
            confirmLabel: t('askpass.yes'),
            cancelLabel: t('askpass.no'),
          });
          answer = yes ? 'yes' : 'no';
        } else {
          answer = await modal.prompt({
            title,
            message,
            inputType: payload.kind === 'secret' ? 'password' : 'text',
            confirmLabel: t('askpass.send'),
            cancelLabel: t('askpass.cancel'),
          });
        }
        if (currentPromptRef.current === payload.promptId) currentPromptRef.current = null;
        const reply: AskpassAnswerPayload = { promptId: payload.promptId, answer };
        try {
          await window.api.invoke(COMMAND_CHANNELS.SSH_ASKPASS_ANSWER, reply);
        } catch (err) {
          console.error('[SshAskpassBridge] answer failed', err);
        }
      },
    );
    const offClosed = window.api.on<{ promptId: string }>(
      EVENT_CHANNELS.SSH_ASKPASS_CLOSED,
      (payload) => {
        if (currentPromptRef.current !== payload.promptId) return;
        currentPromptRef.current = null;
        modal.dismiss();
      },
    );
    return () => {
      offPrompt();
      offClosed();
    };
  }, [modal, t]);

  return null;
}
