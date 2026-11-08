/**
 * @file src/main/tray.ts
 * @purpose 系统托盘管理。常驻托盘图标、右键菜单、单击聚焦最近活动窗口、
 *   "完全退出 Ceteris"流程。
 *
 * @关键设计:
 * - 托盘是应用"始终在线"的代表 (软件定义书 6.5)
 * - 单击: 有窗口聚焦最近活动的;无窗口新开一个 (软件定义书 6.5.2)
 * - 右键菜单 V1 完整规格 (软件定义书 6.5.3) 包括会话子菜单 / 设置 /
 *   完全退出。CP-1 仅实现"打开新窗口" + "完全退出",其余项 CP-3/CP-4
 *   随 SessionManager / SettingsManager 接入后补齐。
 * - 完全退出: 设置 isQuitting → 显式 app.quit(),让 Electron 走标准退出
 *   (before-quit → will-quit → quit)。这样 window-all-closed 不会被
 *   误解为纯托盘模式。
 * - 图标: build/icon-source.png 缩成 16 / 32px 内嵌在本文件,用
 *   nativeImage.createFromBitmap 生成,避免托盘依赖打包资源路径。
 *
 * @对应文档章节: 软件定义书.md 6.5、7.4 节;AGENTS.md CP-1 完成标志
 *
 * @不要在这里做的事:
 * - 不要在这里弹"完全退出"二次确认对话框 (CP-1 还没 session 概念,
 *   无法判断"有 session 在跑"。CP-3 有 SessionManager 后再加,
 *   软件定义书 7.4.3)
 * - 不要直接调 BrowserWindow API (通过 WindowManager)
 */
import {
  app,
  dialog,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { EVENT_CHANNELS } from '@shared/protocol';
import { randomUUID } from 'node:crypto';
import type { WindowManager } from './window-manager';
import type { SessionInfo } from '@shared/types';
import type { SessionManager } from './session-manager';
import type { SettingsManager } from './settings-manager';
import { getAppLabel, getChannel, getRelaunchOptions } from './build-type';
import { logger } from './logger';
import { setQuitting } from './index';

/**
 * 托盘图标的位图,16px(100%)与 32px(200% 缩放)两档,来自 build/icon-source.png,
 * 由 scripts/generate-icon.cjs 用 Lanczos3 缩放后写进来,不要手改。内嵌成 base64 而不是读 build/icon.ico:dev 与打包后的资源路径
 * 不同,托盘又是应用唯一常驻的入口,不能因为找不到文件而不显示。
 *
 * 格式是 createFromBitmap 要的 BGRA、alpha 预乘(圆角外透明)。重新生成:npm run generate-icon。
 */
const TRAY_BITMAP_16 =
  'AAAAABEIBkE4GhLVQx8W/kMfFv9DHxb/Qx8W/0UhF/9GIhn/RyMa/0YiGf9EIBb/Qx8W/jgaEtURCAVBAAAAABEIBkFCHhb+RSAX' +
  '/0IeFv5CHhX/Qx4W/0UhGf8/GhH/Ng8G/zIKAf81DgX/Qh4V/0MfFv5FHxb/Qh4V/hEIBUE3GRLVRR8X/0EdFvpCHhX/RCAX/0Id' +
  'Ff81DgX/Ty4m/4Vvaf+hkIz/hnBq/0IeFf8/GxL/Qh4W+kUfFv83GRLVQh4W/kMeFv5CHhb/RCAY/z8aEv9BHRT/o5KO///////z' +
  '8fH/tKaj/6ubmP+rm5j/Qh4W/0IeFf9DHhb+Qh4W/kIeFv9CHhb/Qx8X/0AcE/9EIRn/zcXD//////+voZ7/QyAX/zILAv8qAQD/' +
  '4Nza/3RaVf83EQj/RCAY/0IeFv9CHhb/Qh4W/0QhGP84Egn/t6qm//////+ikY3/LwIA/0EZEv8/HBP/cVdR/8S7uf9QLyj/PxoR' +
  '/0MfF/9CHhb/Qh4W/0QhGP85Ewr/blNM///////X0M7/OxIK/09RQf9JOi3/Pg8J/1g7M/9FIRn/PhkQ/0MfF/9CHhb/Qh4W/0Ie' +
  'Ff9FIRn/NhAG/7irqP//////gWpk/zUMA/9KNir/XaGB/0xLOv88EQn/Qh8W/0MgFv9CHhX/Qh4V/0IeFf9CHxb/QR4U/0IfFv/i' +
  '3tz//////1Y4L/88FQz/RzAj/12ef/9LSjn/QRcP/0QjGf9CHxX/Qh8V/0IfFf9CHhX/Qh8W/0EdE/9HJRv/7Orp//Hv7/9LKiH/' +
  'PxYP/1NXRv9JOCz/QRIM/0UjGv88Fgz/Qh4U/0MgFf9CHxT/Qh8V/0MgFf9FIRf/OxUM/9HJx///////VC0u/0UbG/9MHh//Sx0e' +
  '/0UaGv8+Dw7/aEdE/2I+Ov9FGxP/SCAW/0cgFP9FHxf/SSIe/0EUFv97Wl///////66Ynf9DBx3/TBAn/04RJf9qOET/w7a3/7mk' +
  'qP9YIib/UyEg/08hHP9LIBf/Sh8f/k0fJ/5VITX/TxMx/5Bmf//t5uz/zbvE/7OWpf/Ktr//7OTo/8aksf91KD3/biIz/2gmMP9b' +
  'IyX+UiEe/kMaJtVbIDz/XBxJ+mQfV/9eEVT/bCBj/5hbkP+sdp//pmmQ/4s3Y/9+F0P/jSZM/4ooSf97Jj36cCcz/08eIdUWCA9B' +
  'YB5O/mwfZf9tHW/+dCF8/3Ygff92GXL/fBhq/4cdZf+XKWf/pDBo/6QsX/+cKlf+litQ/3woPf4bCgxBAAAAABoIGEFcGVvVdR5/' +
  '/nshjP+CKZn/jzGh/542oP+qOJn/sjWN/7Yxfv+zLm//qSxh/oEkRtUjChJBAAAAAA==';
const TRAY_BITMAP_32 =
  'AAAAAAEAAAQAAAAAAAAAABoMCWQ1GBHFQB4V80QgFv9EHxb/RB8W/0QgFv9EIBb/RCAW/0QgFv9EIBb/RCAW/0QgFv9EHxb/RCAW' +
  '/0QgFv9EIBb/RB8W/0QgFv9EIBb/Qx8W/0AeFPM0GBDFGgwIZAAAAAAAAAAAAQAABAAAAAABAAAEAAAAAAkEAyE1GRHKRyAX/0Yg' +
  'F/9EHxb/Qx8W/0MfFv9DHhb/Qx8W/0MfFv9DHxb/Qx8W/0MfFv9DHxb/Qx8W/0MfFv9DHhb/Qx8W/0MfFv9DHxb/Qx8W/0MfFv9D' +
  'Hxb/Qx8W/0UgF/9GIBf/NBgRygkEAyEAAAAAAQAABAAAAAAJBAMhPxwV8kcgF/9CHhb7Qh4W/UMeFv9CHhb/Qh4W/0IeFv9CHhb/' +
  'Qh4W/0IeFv9CHhb/Qh4W/0MeFv9DHhb/Qx4W/0MfFv9DHxb/Qx4W/0IeFv9DHhb/Qx4W/0IeFv9CHhb/QR4W/UIeFvtHIBf/PxwU' +
  '8gkEAyEAAAAAAAAAADQYEcpGIBf/QB0V+UIeFf9CHhX/Qh4V/0IeFf9CHhb/Qh4V/0IeFf9CHhX/Qh4V/0IdFf9CHhb/RCEY/0Ui' +
  'Gf9EIBj/Qh4V/0IeFf9EIBj/RSEZ/0MfFv9CHhX/Qh4W/0IeFf9CHhX/Qh4V/0AdFflHIBf/NBgRygAAAAAaDAlkRiAX/0EeFvtC' +
  'Hhb/Qh4W/0IeFf9CHhX/Qh4V/0IeFf9CHhX/Qh4V/0IeFf9CHhb/RSEZ/0IeFf84Egn/NA4F/zoUC/9AGxP/PxoS/zcRCP80DgX/' +
  'QR0U/0QgGP9CHhX/Qh4V/0IeFf9CHhX/Qh4W/0EeFvtGIBf/GgwIZDMXEcVFHxf/QR4W/UIeFv9DHhb/Qh4W/0IeFf9CHhX/Qh4W' +
  '/0IeFv9CHhX/RCAY/0QgF/82Dwb/QRwU/3JYUv+omJT/ycC9/9rU0//f2tj/zcXC/5F8eP9CHhb/PRgP/0QhGP9CHhX/Qh4V/0Ie' +
  'Ff9CHhb/QR4W/UUfFv8zFxDFPx0U80MeFv9DHhb/Qx4W/0MeFv9DHhb/Qh4W/0MeFv9DHhb/Qh4V/0UiGf89Fw//OxYN/4Vvav/e' +
  '2df///////////////////////j49//v7ez//////+Hc2/9RMSn/PRgP/0QgGP9CHhb/Qh4W/0IeFv9CHhb/Qx4W/z8dFfNCHhb/' +
  'Qh4W/0IeFv9DHhb/Qh4W/0MeFv9CHhb/Qh4W/0IeFf9FIhr/OBIJ/1Q0Lf/NxcP/////////////////+Pf3/7Kkof9vVE3/TSsj' +
  '/0QhGf9GJBz/2tTS/97Z2P8+GRH/Qh4W/0MfFv9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0Ie' +
  'Fv9CHhb/RSIa/zcRCP9nSkT/8/Hx///////49/f//////8vCwP9bPTb/NA4F/zkSCv8/GhL/RCEZ/zAIAP+OenX//////3tiXf83' +
  'EAj/RSEZ/0IeFv9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0MeFv9CHhb/Qh4W/0UhGf85FAv/YkU+//n5+f//////' +
  '+Pj3//////+klJD/OBMK/zsWDf9GIhr/RCEZ/0MfF/9GIxv/NQ4F/7appf//////mIWB/zQOBf9FIhr/Qh4W/0IeFv9CHhb/Qh4W' +
  '/0IeFv9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0IeFv9DHxf/PxoS/0ooIP/p5uX///////f39v//////nYuH/zILAv9EIBj/RCAZ/0Ie' +
  'Fv9CHhb/RCAY/zkTCv9gQjv/+/z7/+vp6f9yV1L/OhML/0QhGP9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0IeFv9C' +
  'Hhb/Qh4W/0UhGf82EAf/uayp///////29fT//////7qtqv80DQX/RB4W/0MfFv9CIBj/Qh4W/0MfFv9CHhb/Qh4W/7uwrv/Hvr3/' +
  'eWJc/0ckHP9BHRT/Qx8W/0IeFv9CHhb/Qh4W/0IeFv9CHhX/Qh4W/0IeFv9CHhb/Qh4W/0IeFv9EIRn/ORMK/21STP//////+vr6' +
  '///////p5uX/SCUd/z8aEv9JMif/Qh0V/z8SDP9DIhj/Qx8X/0AbEv9cPTb/b1VP/0spIv8/GhH/QR0U/0IeFv9CHhb/Qh4W/0Ie' +
  'Fv9CHhb/Qh4W/0IeFf9CHhb/Qh4W/0IeFv9CHhb/Qh4W/0QhGP84Ewr/x767///////4+Pf//////4Zvav81Dwb/RB4W/0k2K/9m' +
  's5T/TllG/z0KBf9CHxb/Qh8W/0MfF/8+GhH/QBwT/0MfF/9CHxb/Qh4V/0IeFv9CHhb/Qh4W/0IeFv9CHhb/Qh4V/0IeFf9CHhX/' +
  'Qh4W/0IeFf9DIBf/PBYN/11AOP/9/f3//P38///////k4N7/QyAY/0EeFf9DIRf/PxQN/1NtWP9w+Mr/WIlu/0AVDv9CHhX/Qh8V' +
  '/0MfFv9DHxb/Qh4V/0IeFf9CHhX/Qh4V/0IeFf9CHhX/Qh4V/0IeFf9CHhX/Qh4V/0IeFf9CHhX/Qh4V/0UiGf80DgT/k4B7////' +
  '///39/b//////6aWkv80DgT/RSIZ/0IeFf9CIBb/PxIL/0c/MP9q4LX/YKqJ/0AWDv9CIBf/Qh8V/0IeFf9CHxX/Qh8V/0IfFf9C' +
  'HxX/Qh4V/0IeFf9CHhX/Qh4V/0IeFf9CHxX/Qh8V/0IfFf9CHxX/RCIY/zYRB/+/tLH///////n5+P//////c1pT/zgTCf9EIRj/' +
  'Qh4V/0IhF/8+Egr/Rzss/2retP9fqIb/QBYO/0IgFv9CHxX/Qh8V/0IfFf9CHxX/Qh8V/0IfFf9CHxX/Qh4V/0IfFf9CHxX/Qh4V' +
  '/0IfFf9CHxX/Qh8V/0IfFf9CHxb/PhoR/9jS0P///////f79//j49/9XODD/PBgO/0MgFv9CIRb/PhML/1FiTf9y9cj/WIZq/z8U' +
  'C/9BHhT/Qh8V/0IfFf9CHxX/Qh8V/0IfFf9CHxX/Qh8V/0IeFf9CHxX/Qh8V/0IeFf9BHhT/Qh8V/0IfFf9CHxX/QyAW/0IfFf9D' +
  'IBb/4Nva////////////7Oro/0ooIP8/GxL/QyAW/0AZEP9LNir/bLya/1BYRP8+DAX/QyAW/0IfFf9CHhT/Qh8V/0IfFf9CHxX/' +
  'QyAW/0EeFP9CHhX/Qh8V/0IfFf9CHxX/Qh4V/0IeFf9CHhT/Qh4V/0IeFf9CHxX/Qx8V/z8bEf/Z0tD////////////q5+b/SiYg' +
  '/0EbFf9EHxj/QxwW/088Mv9JKCH/QREO/0UhG/9EHhj/RB4X/0QeF/9EHhb/RCAW/0QgFv8+GQ7/RiEY/0MfFf9CHxT/Qx8U/0Mf' +
  'FP9CHxT/Qh8U/0MfFf9DHxX/QyAU/0MfFP9GIhf/NxEG/7uvrP///////f39//X08/9VMi//QhoW/0cgHf9HHx7/Rhwa/0YcGv9I' +
  'IR//Rx4c/0ceHP9HHhv/Rx8c/0ghHf9DGhX/PxUP/2A+Of9bOTP/QhoR/0YfFv9GHhX/RiAU/0YgFP9FIBT/RSAU/0QgFP9EHxX/' +
  'RB8X/0ciG/85EAv/hm1q///////4+Pf//////3ZXWP9AFBf/TSIm/0seI/9MHyT/TSAl/00eJP9NHyP/TSAj/1AkJv9LHR7/RRUU' +
  '/2E6Ov+SeHn/im1s/0kcGP9MHxv/Sx8Z/0ofF/9JHxX/SiAV/0khFf9EHxX/RB8W/0UfGP9GHxv/SB8d/0geHv9LISP/493d////' +
  '////////v6+y/0EMGf9VJTH/UyEu/1QgLv9UIC7/ViIv/1gkMP9WIiz/ShIc/1glLP+ji43/3tja/8K1t/9WJSb/UR4d/1IiIP9P' +
  'IB3/TSAb/0sgGf9JIBb/SSAV/0YfF/9HHxr/SR8c/0ofH/9KHyP/TyIp/0YUH/92UVv/////////////////j2x5/0cJI/9TGDH/' +
  'WBw1/1gcNP9VGC//UhEo/1odMP+NZnD/5Nze///////a0dP/c0FJ/1sfJv9dJSr/WSIl/1YjIv9TISD/USEd/04gGv9KIBf/SR8a' +
  '/0ofHv9LHyL/TB8m/08fKv9RHy//ViI3/0wSK/+DWm7/8/Dy////////////tJin/3hCYP9qLE7/bC5N/31FYP+lf5D/4NTZ////' +
  '////////0L7D/3w9Tf9oHjD/bCY1/2ckMP9jJC3/XyMp/1ojJP9WIiH/UiEe/08hGv9IHh7zTSAk/04fKf9RHy//VB81/1geO/9Z' +
  'Hj//XiFH/1USPf9tMVn/vKCz//Ht7/////////////3+/f/9//7/////////////////3MvT/6Nugv92Ij7/eSA8/30pQv95Jj3/' +
  'dSY5/28mNf9pJTD/YyQr/1wkJf9XIyH/Th8d8zsYHcVRICv/UR8y/VceOv9bHkH/XR1H/18dTP9gHFH/ZiBY/2MYVv9dD0//cStl' +
  '/5BYhv+vhqb/wqK6/8anvP+8la3/p3KQ/45Fa/96IEv/ehpD/4YoTf+JKUz/iCdI/4UnRv+AJ0H/eyc9/3QnN/9sJjL/ZCQt/WAl' +
  'J/9EGxrFHwwRZFYhNf9YHzv7XR5E/18dTP9iHVP/ZB1a/2cdX/9pHWP/bR9p/3Aibf9vHGr/bBVj/2wTX/9vFFv/chVY/3YXVv97' +
  'GVX/gyFY/4wrXf+QLVz/kipW/5MpU/+TKVH/kChN/4woSf+FKET/fig+/3YnOP9qJTD7aCcu/yQOD2QAAAAARhkvymIgSP9eHU35' +
  'Yx5Y/2YdX/9qHWb/bB1s/24ecf9wHnX/ch93/3YieP97JXn/gCh4/4Mqdf+GK3L/iyxv/44tbP+SLGj/lixk/5osYv+eK1//nytb' +
  '/50qWf+aKlb/lilR/5AoTP+GKEX/eyc++XsqOv9UHibKAAAAAAAAAAAMBAghWhxI8mogXv9lHV77ah1n/W4dcP9wHnf/ch58/3Yf' +
  'gP94IYL/eyOC/34mgf+CJ3//hyl9/40rev+SLHf/ly10/5wtcf+hLm7/pC5r/6ctZ/+oLGT/pyxg/6MrXP+eK1j/lipR/YwoS/uM' +
  'LEn/dCU58g4FByEAAAAAAQABBAAAAAANBAshURdKynEgbf9zH3X/ch56/3QegP94H4X/eiGJ/3wkjv+AKJL/hSuT/4wtlP+SL5P/' +
  'mTGQ/54yjf+jMon/qTKE/60xf/+wMHj/sS9y/7Aubv+uLWj/qyxh/6YsXf+jLVr/nS1U/20gOcoQBQkhAAAAAAIBAQQAAAAAAgAB' +
  'BAAAAAAAAAAAKwwqZFcXWsVvHHjzeR6F/3whjP9+JJX/giqf/4gupv+PMav/lzSt/6A2rv+nOKz/rjmp/7I5pP+3OJ7/ujeW/7s0' +
  'jP+7MoP/uC95/7Uub/+vLGb/oSpb83whRMU8ESBkAAAAAAAAAAACAQEEAAAAAA==';

/** active 状态光点,在深色底上保持可辨 */
const TRAY_ACTIVE_DOT: readonly [number, number, number] = [0xff, 0xd3, 0x7a];

/**
 * 在一份位图上点亮右上角的光点。右上角在图标里只有深色底,4×4(16px)/ 8×8(32px)
 * 才看得出来。buf 是 BGRA,光点不透明所以不需要预乘。
 */
function paintActiveDot(buf: Buffer, size: number): void {
  const dot = size / 4;
  const x0 = size - dot - size / 8;
  const y0 = size / 8;
  for (let y = y0; y < y0 + dot; y++) {
    for (let x = x0; x < x0 + dot; x++) {
      const i = (y * size + x) * 4;
      buf[i] = TRAY_ACTIVE_DOT[2];
      buf[i + 1] = TRAY_ACTIVE_DOT[1];
      buf[i + 2] = TRAY_ACTIVE_DOT[0];
      buf[i + 3] = 0xff;
    }
  }
}

/**
 * 生成托盘图标,不依赖打包资源路径,dev 与生产行为一致。
 *
 * M1-E 起,接受 variant 区分三态(spec 6.5.1):
 *   - 'default':无 session 或 idle
 *   - 'active':右上角琥珀色光点,至少一个 session 处于 active
 *
 * 16px 是 1x 表示,32px 以 scaleFactor 2 加进去,高 DPI 屏幕上托盘不会糊。
 */
function generateTrayIcon(variant: 'default' | 'active'): NativeImage {
  const small = Buffer.from(TRAY_BITMAP_16, 'base64');
  const large = Buffer.from(TRAY_BITMAP_32, 'base64');
  if (variant === 'active') {
    paintActiveDot(small, 16);
    paintActiveDot(large, 32);
  }
  const image = nativeImage.createFromBitmap(small, { width: 16, height: 16, scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: large });
  return image;
}

export class TrayManager {
  private tray: Tray | null = null;
  /** M1-H:状态变化节流,避免高频抖动 */
  private rebuildTimer: NodeJS.Timeout | null = null;
  private currentIconVariant: 'default' | 'active' = 'default';

  constructor(
    private readonly windowManager: WindowManager,
    private readonly sessionManager?: SessionManager,
    private readonly settingsManager?: SettingsManager,
  ) {}

  /**
   * 初始化托盘。必须在 app.whenReady() 之后调用。
   * 重复调用会先销毁旧的再建新的。
   */
  init(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    this.tray = new Tray(generateTrayIcon('default'));
    this.tray.setToolTip(getAppLabel());

    this.tray.on('click', () => this.handleSingleClick());
    // 双击在 Windows 等同于单击 (软件定义书 6.5.2: "避免双击意外行为")
    this.tray.on('double-click', () => this.handleSingleClick());

    this.rebuildContextMenu();
    this.refreshIcon();

    // 窗口 / session 变化都触发菜单 + 图标重建(节流 300ms)
    this.windowManager.onWindowCreated(() => this.scheduleRebuild());
    this.windowManager.onWindowClosed(() => this.scheduleRebuild());
    this.sessionManager?.on('sessionCreated', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionDestroyed', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionStateChanged', () => this.scheduleRebuild());
    this.sessionManager?.on('sessionOwnerChanged', () => this.scheduleRebuild());
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildContextMenu();
      this.refreshIcon();
    }, 300);
  }

  /**
   * M1-H:刷新图标与 tooltip,根据当前 session 集合判断 active/idle。
   */
  private refreshIcon(): void {
    if (!this.tray) return;
    const sessions = this.sessionManager?.list() ?? [];
    const total = sessions.length;
    const live = sessions.filter((s) => s.state !== 'exited').length;
    const active = sessions.filter((s) => s.state === 'active').length;
    const desired: 'default' | 'active' = active > 0 ? 'active' : 'default';
    if (desired !== this.currentIconVariant) {
      this.currentIconVariant = desired;
      try {
        this.tray.setImage(generateTrayIcon(desired));
      } catch (err) {
        logger.warn('TrayManager', 'setImage failed', err);
      }
    }
    this.tray.setToolTip(
      `${getAppLabel()}: ${total} 个会话${total > 0 ? ` (${live} 运行中,${active} 活跃)` : ''}`,
    );
  }

  /**
   * 销毁托盘图标。在 app.quit 真正执行前调用,避免图标残留几秒钟。
   */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /**
   * 单击 / 双击托盘:
   * - 有窗口 → 聚焦最近活动的 (若被最小化则恢复)
   * - 无窗口 → 新开一个
   */
  private handleSingleClick(): void {
    const recent = this.windowManager.getMostRecentlyActive();
    if (recent) {
      if (recent.isMinimized()) recent.restore();
      if (!recent.isVisible()) recent.show();
      recent.focus();
      return;
    }
    try {
      this.windowManager.createWindowFromFactory();
    } catch (err) {
      logger.error('TrayManager', 'handleSingleClick: createWindow failed', err);
    }
  }

  /**
   * 重建右键菜单。M1-H 完整化(spec 6.5.3):
   *   - 打开新窗口
   *   - 显示所有窗口(>=1 窗口时)
   *   - 关闭所有窗口(>=1 窗口时)
   *   - --
   *   - 正在运行的会话(子菜单,>=1 session 时)
   *   - --
   *   - 设置
   *   - 重新启动(npm run dev 下没有:重启会断开 dev server)
   *   - 完全退出 Ceteris
   */
  private rebuildContextMenu(): void {
    if (!this.tray) return;

    const sessions = this.sessionManager?.list() ?? [];
    const liveSessions = sessions.filter((s) => s.state !== 'exited');
    const windowCount = this.windowManager.count();

    const items: MenuItemConstructorOptions[] = [];

    items.push({
      label: '打开新窗口',
      click: () => {
        try {
          this.windowManager.createWindowFromFactory();
        } catch (err) {
          logger.error('TrayManager', 'open new window failed', err);
        }
      },
    });

    if (windowCount > 0) {
      items.push({
        label: '显示所有窗口',
        click: () => {
          for (const info of this.windowManager.list()) {
            const w = this.windowManager.getById(info.id);
            if (!w || w.isDestroyed()) continue;
            // Hidden windows are views swapped out by the ViewSwitcher. Their
            // visible partner is the same window as far as the user can tell.
            if (!w.isVisible()) continue;
            if (w.isMinimized()) w.restore();
            w.show();
          }
        },
      });
      items.push({
        label: `关闭所有窗口 (${windowCount})`,
        click: () => {
          // 关闭所有窗口 — 不影响 session,应用进入"纯托盘模式"
          for (const info of this.windowManager.list()) {
            this.windowManager.closeWindow(info.id);
          }
        },
      });
    }

    items.push({ type: 'separator' });

    // 正在运行的会话子菜单
    if (sessions.length > 0) {
      const submenu: MenuItemConstructorOptions[] = sessions.map((s) =>
        this.buildSessionMenuItem(s),
      );
      items.push({
        label: `正在运行的会话 (${sessions.length})`,
        submenu,
      });
      items.push({ type: 'separator' });
    }

    items.push({
      label: '设置…',
      click: () => this.openSettings(),
    });

    items.push({ type: 'separator' });

    if (getChannel() !== 'dev') {
      items.push({
        label: `重新启动 ${getAppLabel()}`,
        click: () => void this.restartApp(),
      });
    }

    items.push({
      label: `完全退出 ${getAppLabel()}${liveSessions.length > 0 ? ` (${liveSessions.length} 个会话运行中)` : ''}`,
      click: () => this.quitApp(),
    });

    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  /**
   * 构造"正在运行的会话"子菜单中的单项。
   * 状态符号:● active / ◐ idle / ○ exited;点击 → 聚焦 owner 窗口并选中该 session。
   */
  private buildSessionMenuItem(s: SessionInfo): MenuItemConstructorOptions {
    const symbol = s.state === 'active' ? '●' : s.state === 'idle' ? '◐' : '○';
    const cwd = s.currentCwd || s.originalCwd;
    const cwdShort = cwd.length > 50 ? '…' + cwd.slice(-47) : cwd;
    return {
      label: `${symbol} ${s.displayName}   ${cwdShort}`,
      click: () => this.focusSession(s),
    };
  }

  private focusSession(s: SessionInfo): void {
    try {
      const ownerId = s.ownerWindowId;
      if (ownerId) {
        const win = this.windowManager.getById(ownerId);
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
            eventId: randomUUID(),
            timestamp: Date.now(),
            payload: { reason: 'tray-session-click', selectSessionId: s.id },
          });
          return;
        }
      }
      // 无 owner:新开窗口并发选中事件
      const info = this.windowManager.createWindowFromFactory();
      const win = this.windowManager.getById(info.id);
      // 窗口 ready 后才发(否则 webContents.send 没人接);用 once webContents.did-finish-load
      win?.webContents.once('did-finish-load', () => {
        if (win.isDestroyed()) return;
        win.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
          eventId: randomUUID(),
          timestamp: Date.now(),
          payload: { reason: 'tray-session-click', selectSessionId: s.id },
        });
      });
    } catch (err) {
      logger.error('TrayManager', 'focusSession failed', err);
    }
  }

  private openSettings(): void {
    try {
      let recent = this.windowManager.getMostRecentlyActive();
      if (!recent) {
        const info = this.windowManager.createWindowFromFactory();
        recent = this.windowManager.getById(info.id);
      }
      if (!recent || recent.isDestroyed()) return;
      if (recent.isMinimized()) recent.restore();
      recent.focus();
      // 让 renderer 切到 settings 视图。当前没有 cmd:view:enter-settings,
      // 复用 WINDOW_FOCUS_REQUESTED + 一个特殊 reason,renderer 端识别即切。
      recent.webContents.send(EVENT_CHANNELS.WINDOW_FOCUS_REQUESTED, {
        eventId: randomUUID(),
        timestamp: Date.now(),
        payload: { reason: 'tray-open-settings' },
      });
    } catch (err) {
      logger.error('TrayManager', 'openSettings failed', err);
    }
  }

  /**
   * 完全退出应用 (软件定义书 7.4.3)。
   *
   * CP-4 起完整版:
   * - settings.behavior.confirmOnQuit=true 且有 session 在跑(state≠exited)
   *   → 弹 dialog.showMessageBox 二次确认
   * - 用户点"取消" → 不退出
   * - 用户点"退出" → setQuitting + app.quit (will-quit 会负责 SIGTERM
   *   + 等 5 秒强制 kill,见 软件定义书 7.4.3)
   *
   * 关闭单窗口绝对不调到这里 (软件定义书 7.4.1, AGENTS.md 红线)。
   */
  private async quitApp(): Promise<void> {
    const proceed = await this.confirmEndingSessions(
      '完全退出',
      '如果只想隐藏窗口,请关闭窗口而不是"完全退出"。',
    );
    if (proceed) this.leave();
  }

  /**
   * Quits and starts again, so an installed update or a stuck app starts fresh.
   *
   * Terminals live in this process, so a restart ends them just as quitting does. Session
   * restore is not built, which is why the warning says they do not come back.
   */
  private async restartApp(): Promise<void> {
    const proceed = await this.confirmEndingSessions(
      '重新启动',
      '窗口会重新打开,但这些终端不会恢复。',
    );
    if (!proceed) return;
    logger.info('TrayManager', 'restarting');
    // relaunch only schedules the new process; it starts once this one has exited.
    app.relaunch(getRelaunchOptions());
    this.leave();
  }

  /** Asks before ending running terminals, if the user wants to be asked. */
  private async confirmEndingSessions(action: string, detail: string): Promise<boolean> {
    const settings = this.settingsManager?.get();
    const confirmOnQuit = settings?.behavior?.confirmOnQuit ?? true;
    const sessions = this.sessionManager?.list() ?? [];
    const liveCount = sessions.filter((s) => s.state !== 'exited').length;
    if (!confirmOnQuit || liveCount === 0) return true;

    const owner = this.windowManager.getMostRecentlyActive();
    const result = await dialog.showMessageBox(owner ?? (undefined as never), {
      type: 'warning',
      title: `${action} ${getAppLabel()}?`,
      message: `还有 ${liveCount} 个终端在运行,${action}会关掉它们。`,
      detail,
      buttons: ['取消', action],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  }

  /** The standard exit: before-quit, then will-quit shuts sessions down and saves. */
  private leave(): void {
    setQuitting();
    this.destroy();
    app.quit();
  }
}
