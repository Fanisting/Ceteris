# Your name

Ceteris asks once what it should call you. After the first start cards (main agent, then extension setup), a small card appears in the bottom right corner: "Hi! What should I call you?". The field starts with your computer account name, first letter capitalised. Press Save (or Enter) to keep it, or Skip (or Escape) to go without a name. The card never comes back by itself, and existing users see it once after the update. It does not block the window; you can keep working while it is open.

With a name, Ceteris uses it in a few places:

- The new tab page shows one quiet line at the top: "Hi Xuhang · good morning" (afternoon from 12, evening from 18).
- Notices that tell you something end with your name, for example "Claude is waiting for your decision, Xuhang". This covers the choice notice, the system notification when a belled tab finishes, and the agent update notices for a new version, a finished update and tabs that came back after a full reload.

Labels, buttons and error messages stay neutral, and the name is never sent to an agent or a terminal. Without a name every notice reads as before and there is no greeting.

Change or clear the name in Settings, Appearance, Your name. It is stored in `behavior.userName` (at most 40 characters); `behavior.userNameAsked` records that the card was answered.

Related: [ADR-052](../docs/软件定义书.md), [Choice notice](agent-choice-notice.md), [Done notifications](done-notifications.md) and [Main agent](main-agent.md).
