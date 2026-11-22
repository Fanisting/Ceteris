# Cute notifications written by AI

When an agent tab with its bell on finishes, Ceteris can ask an AI to write the [done notification](done-notifications.md) in a cute voice. The notification says what got done and the one small step left for you, so you want to click it and finish the work.

## Turning it on

Settings → Notifications → **Cute notifications written by AI**. It is off until you turn it on. It uses the OpenRouter account you connected in Settings → AI for [next prompt suggestions](next-prompt-suggestions.md); until one is connected, you get the plain notification.

## Five voices

Pick one of five cards. Clicking a card shows two example notifications in that voice, one for a finished turn and one for a turn that stopped to wait for you. The examples are real outputs from our tests, with your name filled in.

| Voice                   | What it sounds like                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| A Mascot (团子)         | A round fluffy creature beside you, proud of the agent, with kaomoji                            |
| B Last bite (最后一口)  | A warm cheerleader: what is ready and the one small step left, like the last bite of dessert    |
| C Cat (小猫)            | The agent is a cat that brought something back and waits by the door for praise                 |
| D Quest (副本)          | A cute RPG: the result is loot, a stuck turn is a boss choice                                   |
| E Sticker book (贴纸本) | Each finished turn today is a sticker; clicking collects it. Ceteris counts the stickers itself |

**Send a real one in this voice** asks the AI to write a sample notification for a made up "login tests fixed" turn and shows it right away, so you can check the voice, the model and your OpenRouter connection.

## What the AI sees

- **Names only**: the agent, the tab name, the folder, how long the turn took, and what Ceteris calls you. The notification can say which tab is ready, but not what happened.
- **Also the last 600 characters of the answer** (the default): now it can say "42 tests pass" or "stopped at step 3, needs your pick".

Either way the text goes only to OpenRouter. Tabs opened over [Ceteris Link](ceteris-link.md) always use names only, because their screen is on the other computer.

## Honest and on time

A stuck or failed turn always reads as "needs you", never as a win. If the AI does not answer within 5 seconds, or answers with something unusable, the plain notification goes out instead. Long text is cut to what a notification shows.

## Model

The default model is GLM 5.3 Flash (`z-ai/glm-5.3-flash`): in our test it answered in about 0.7 seconds and costs about $0.00005 per notification. You can type any other OpenRouter model id.

Related: [Software definition](../docs/软件定义书.md) (ADR-057), [Done notifications](done-notifications.md), [Your name](user-name.md).
