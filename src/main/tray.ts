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
  shell,
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
import type { UpdateStatus } from '@shared/update-check';
import { getAppLabel, getChannel, getRelaunchOptions } from './build-type';
import { logger } from './logger';
import { setQuitting } from './index';

/**
 * 托盘图标的位图,16px(100%)与 32px(200% 缩放)两档,来自 build/icon-source.png,
 * 由 LANCZOS 缩放得到。内嵌成 base64 而不是读 build/icon.ico:dev 与打包后的资源路径
 * 不同,托盘又是应用唯一常驻的入口,不能因为找不到文件而不显示。
 *
 * 格式是 createFromBitmap 要的 BGRA、alpha 预乘(圆角外透明)。重新生成见 build/README.md。
 */
const TRAY_BITMAP_16 =
  'AAAAAAYFBikaFRm2Ihwh9CQcIv4kHSP/JB0i/yQdI/8lHiP/JR4j/yQdIv8iGyD+Hxgd9BUQFbYFBAUpAAAAAAUEBSgcFRrk' +
  'HBYa/xkTF/8ZExf/GhQY/xwWGv8VDxP/DQYM/wsFCf8NBwr/EgwP/xYQFP8XERX/FQ8T5AQDBCgWERS7GhQY/xYQFPoWEBT/' +
  'GhQY/xUOFP8QCBP/Licy/1lUXf9kYGz/TUhW/yYfKf8RCw//Ew4S+hUPE/8RDA+7GhQX+RYQFP4VDxP/GBMX/xILFP83Lz//' +
  'qqew/+jn7f/Pztf/urrT/8jD+f+8su//S0Nc/wsGCP8UDxP+FQ8T+RkTF/8UDxL/FhEU/xAJEv9SS1v/7ezw/9jW5v9JRVH/' +
  'EQwU/wcDB/8zLkH/uLHg/zgzQv8FAQP/Eg4S/xMOEf8YEhb/FA8S/xAKEP81LTv/6ejy/8jD5v8uJ0L/AwAC/w8LEP8PCw//' +
  'BwQG/yYjKf8kHC//NyxK/xMNGP8SDRD/FhEU/xUQE/8JAwv/mJWh/9LN9v9xZ5r/DgoN/xgTG/9COlH/PjVL/xYRGv8NCA//' +
  'PzJV/5SDuv8sITv/DwoN/xYQE/8QCw//GxYc/66pyP+5sOv/cGuD/wgECf8+NFD/LCQ4/ywjOP8xKD//Eg4T/woFDf86LU//' +
  'OC5H/wsHCf8WEBT/DQgM/ychLv+ro9D/2tX8/357if8LBQ7/LSQ6/xwVJf8XEB7/GRIi/xcRHf86MUf/RzxZ/xMNF/8PCw7/' +
  'Ew4R/xoUH/8eFyb/pqK+/+bh/v+no7z/BgIG/xAMEv8YEh7/Jx8y/0M5Uv9NQl3/NSxC/xIMFf8MCAv/DwsO/xALDv8qITX/' +
  'Jhw0/29ogv/Vyf//w7fy/2JZeP8vJjj/RTpV/0k+Wv8pIjH/JB8o/yEcI/8JBgj/DQoM/w4KDf8UDhL/Eg0T/zAlP/86L0z/' +
  'j326/8Kp//+1m/P/b1uX/ysiN/8TDhb/OTFD/5aNr/8iHib/CAQG/wwJC/8OCgz/Eg0Q+Q4KDP4KBgf/BwUG/wsHDf9UQnj/' +
  'jXDL/6uM7f+yl+z/rJTd/6qX0f88NUj/AQAA/w0KDP8KBwn+DgoM+Q4KDLsPCg3/DQkL+g0KDP8LCAn/AAAA/xIOFP8xKDz/' +
  'QDZL/zIqO/8IBgj/AAAA/w0JC/8KBgj6DAgK/wsHCbsDAgMoDgoN5A4JDP8MCAr/DAgK/w0JDP8JBQb/AgAA/wAAAP8CAAD/' +
  'CgcJ/w0JC/8LBwn/DAcK/wwHCuQDAgIoAAAAAAMCAikLCAq2DgoL9A8KDf4PCgz/DwoN/xELD/8RDA//EQwP/w8KDf8OCQz+' +
  'DQkL9AsGCbYDAgIpAAAAAA==';
const TRAY_BITMAP_32 =
  'AAAAAAAAAAEAAAABAAAAAAgHCDEaFRiYJh4j3CohJ/kqIij+KiIo/yoiKf8rIin/KiIp/yoiKP8qIij/KiIo/ykhJ/8pISj/' +
  'KiEo/yggJv8oICf/KCAm/yggJf8mHyT+JR4j+SIbINwVERWYBwYHMQAAAAAAAAABAAAAAQAAAAAAAAABAAAAAQEAAQIUEBOH' +
  'Ixwh9iMbIf8gGR7/Hxgd/x8YHf8eFx3/Hxcd/x8YHf8eFxz/Hhcc/x4XHP8dFhv/HBYb/xwWG/8cFRr/HBUa/xwVGv8cFRr/' +
  'GxQZ/xsUGf8bFBn/GxQZ/x0WG/8eFhr2EAwPhwAAAAIAAAABAAAAAQAAAAMBAQEDFxIWryIbIf8cFRr/GhQY/BsUGf4bFBn/' +
  'GxQY/xsUGf8bFBn/GxQZ/xsVGf8bFBn/GhQZ/xoUGP8aExj/GhQY/xkTF/8ZExf/GRMX/xgSFv8XERX/FhEU/xcRFP8WEBT+' +
  'FhAU/BcRFf8bFBj/Eg4QrwEAAQMAAAADAAAAABEOEIchGR//GRMX+RkTF/4ZExf/GBIW/xkTFv8ZExf/GRMX/xkTF/8YEhf/' +
  'GRMY/xoUGf8aFBn/GxUa/xwWG/8cFhz/HBYb/xwWG/8bFRr/GhQZ/xgSF/8WEBT/FQ8T/xUPE/8UDxL/FA8S/hQPEvkaExf/' +
  'DgsNhwAAAAAGBQYuHhcc+xoUGPwYEhb+GBIV/xcRFf8XERX/GBEW/xgSFv8YEhb/GBIX/xkSGP8aFBr/Hhgf/x0XHv8XEBn/' +
  'EwsV/xEJE/8RCRL/EQkS/w8ID/8NBgz/DwkN/xQPE/8WERb/FA4S/xQOEv8UDhL/Ew4S/hQPEvwXEhX7BQQFLhMPEpsdFhr/' +
  'FxEV/BcRFf8XERT/FhAU/xYQFP8WERX/FxEW/xgSF/8aExr/Hxgg/x0WIP8XDxz/Ixsq/0Q9Sv9oYm//gn6K/5CNmv+Qjp//' +
  'hYKW/2tme/9FPk//HRYe/w0HCv8UDxP/Ew4S/xMNEf8TDhH/Ew4R/BcRFP8QDA6bHBYZ3xoTF/4XERX+FhAU/xYQFP8VDxP/' +
  'FRAT/xYQFf8YEhf/HBUd/yEaI/8ZER//NS0+/4F8if/Gw83/8/L5/////////////////+/w///b2f//zcj+/8K69f+kmtH/' +
  'WE9t/xUPFP8UDhP/Ew4R/xMNEf8SDRD+FA4S/hYRE98dFhv7GBIV/xYQFP8VDxP/FA8S/xQPEv8VEBT/FxEX/x0WHv8fFyP/' +
  'Ihkr/3p0g//e3OX////////////w8Pf/ubfB/5COmv+BgJL/jYms/7Kr4/+9tPT/safk/8C29/+qn9n/GBMa/xINEv8SDhL/' +
  'Eg0R/xINEP8SDRD/FxEV+x0WGv8XERX/FRAT/xQPEv8UDxL/FA8T/xUQFf8cFR7/HRYi/y8mOf+yrrr//v7///z8///08/z/' +
  'npqp/zg0QP8TDhn/CAQM/wYBB/8HAwb/IR0o/4iArv/Bt/T/yMD3/2tkgP8JBAj/FRAW/xENEf8RDRD/EQwQ/xINEP8WEBT/' +
  'HBUa/xYQE/8UDxL/FA4S/xQOEv8UDxT/GRMa/x0VIf8vJjn/xsPP///////09Pr/4Nz0/2xlh/8OCBX/Eg0W/xYSGP8VERb/' +
  'FBAV/xMPFP8JBgj/BgQG/5WQtP/PyvP/Ih0n/xEME/8VEBf/Eg4U/xEMEv8QDBD/EAwP/xYQFP8bFRn/FRAT/xQOEv8TDhH/' +
  'Ew4S/xYRF/8cFiD/HhUn/7Swvv//////8PD5/8jD6P9xZpz/Ew4Z/xgTGv8VERf/Eg4U/xIOE/8SDhP/EAwR/xMPFf8HBAf/' +
  'KSUs/2Nfb/8LBg7/GhQg/xkSIf8ZEiD/FRAZ/xENEv8QCw//FRAT/xoUGP8VDxP/FA4S/xMOEv8UDxT/GxUc/xMLGf90bn7/' +
  '/////+3t+v+zrNX/i3/C/zMtQf8RDRH/FBAX/xIOFP8UEBb/DQkO/w4JD/8TDxX/EQ0S/xIOFP8MCQ3/CQQK/xsUIv8qHzz/' +
  'RDNn/zUlUP8eFSj/Ew4W/xALEP8UDxL/GhQY/xQPEv8TDRH/Ew4S/xUPFf8YEhv/KCAv/9bU4v/09f3/rabR/5OIyv96c57/' +
  'DwsP/xQQF/8TDxX/FA8X/xINFv8zLD3/MCk5/xEMFf8VEBj/FBAX/xcSG/8hGin/MSZD/1tIhP/o3vz/oZHE/yIUOf8XEhz/' +
  'EQwS/xQPEv8ZExb/Ew4R/xINEP8SDRL/FxIY/w4IEv9lX27/+/z//7iy3P+Og8D/sajh/1BLY/8HBAb/FhEY/xINFP8SDBb/' +
  'XVNz/2pgf/9uY4T/TEJf/w0IEP8VEBj/Ew8W/xQPF/8bFCP/NCVO/35uof+Fcqz/U0Nw/xQOGf8TDhT/FA8T/xgSFf8TDhH/' +
  'Eg0Q/xINEf8XEhj/DQYS/6Ohrv/c2ff/mIzI/6qi1v+4seH/Mi46/wsHC/8TDxb/GxUi/1VKbf9NQmT/EAgW/xQNHP9SRmn/' +
  'QjdW/xYQGv8SDhX/Ew4V/xUQGv8eFij/HhIx/y0fQ/9oWYP/EgwX/xINE/8UDhL/GBIV/xINEP8RDBD/EQ0R/xQPFf8YEhz/' +
  'vbvO/7Sr4f+qodb/vLXj/7653/8mIir/DAgO/xkTH/9LQGH/PDJP/xoSIf8ZEx//GRMf/xYQHP82LUj/MilC/xALEv8TDhX/' +
  'FA8X/xcSHP8NBxL/WUxv/0w/Yf8NCA//EQwS/xMOEf8YEhX/Eg0Q/xEMD/8SDRL/Eg0U/yEcJP+zrdD/tKvh/7y14f/KxOv/' +
  'zMnl/ygjLP8MBw3/IBko/zktS/8WDx3/HBUk/xsVJP8bFCP/GRIf/x4WJ/8pHzb/FA8X/xYRGf8QCxT/DwkW/1ZKav9oWYL/' +
  'Fg4e/xINFf8OCg//Eg0Q/xcRFf8SDRD/EQwQ/xMOFP8TDhf/LyY7/6ujzv/DvOv/x8Lo/9PP7v/g3vT/ODQ9/wsHDf8UDxb/' +
  'JBwu/ywiOv8nHjT/JRwx/yIZLf8gGCr/Ihos/xwVI/8SDRf/DwkW/zIoP/9xY4n/X1F2/xYPH/8SDRb/DwsQ/w0JDf8SDRD/' +
  'FxEV/xINEf8TDhP/EQwS/zIoQv8hGSv/mpW1/9TO9//QzOz/1dHu/+vo//9dWWX/BgII/xYRGP8SDhT/FA8X/xYQGv8YEh3/' +
  'GhQg/xoUIP8UDRv/Fg4g/zYsRP9qXn7/dWiL/zowSP8PCRX/Ew4V/xALEf8OCg3/DQkL/xEND/8XERX/Ew4T/xALEP8lHS//' +
  'Oi9M/wAAAP96dov/4Nz//8/K6//Ry+3/3df8/56Ztf8LBg3/FxIa/xYRGP8VERj/FA8X/xIMFv8UDhz/Jh0z/01CYP93a4z/' +
  'dmuK/0Y8VP8UDRv/DgkR/xMOFf8PCxD/DQkN/w0JDP8MCQv/EQwP/xcRFf8UDxX/DgkN/0I1WP8iGiv/AQAA/zYyPP/X0vf/' +
  'ysPu/8W87P/Cuez/zMP6/01FX/8GAAn/Ew0Z/xYPHf8oHzT/RjpY/2ZYf/94a5H/aV57/zkxRv8WDx3/BgEI/xIOFP8SDhT/' +
  'DgoP/w4KDf8NCQz/DAkL/w0JC/8RDA//FxEV/xQOFP8OCQ7/OS1L/1dGdv8lHDD/DAYR/4Z9o//Lvv7/tKPn/7al7f+/r/f/' +
  'uanq/1ZMaP9WSmn/b2CJ/3Bhi/9fUnX/QDVP/x8YKP8PCRT/Ew4X/wEAAv9FQUv/YVxq/wUDBf8QDBD/DQkM/wwJC/8MCAv/' +
  'DAgK/xEMD/8WEBT/Eg0R/xINE/8RDBP/PTBR/2FQgv9gTn3/alqJ/7+s8f/Muf//xrXz/8i29v/HtPf/waz3/3Nilf8pITH/' +
  'EgwW/wwHD/8NCRD/EQ0T/w4KD/8CAAD/QDxF/9PK7/85M0H/BQIE/w4LDv8MCQv/DAgL/wwICv8MCAr/EQwO/xYQFP8RDA//' +
  'EAwQ/xEMEv8MCAz/EAsT/x4XJv8fGCj/MSdB/5yD2P+ylPr/noLg/5Z52P+Td9X/knfR/25Zmf8/M1L/Ixwq/xkUG/8aFBz/' +
  'Lic0/3Johf/k1P//jYKp/wAAAP8OCw//DAgL/wwIC/8MCAv/DAgK/wwICv8RDA//FQ8T+xEMD/8PCw7/DwoO/w8LD/8PCxD/' +
  'DQkN/w0JDv8HBAf/GhQi/3hhqf+pifH/pYXq/5l72f+WeNT/oILi/6mM6v+hiNn/mYLJ/6GK0f/Dq/f/5Mz//56PwP8SDhT/' +
  'CQYJ/wwIC/8LCAr/CwgK/wsICv8LCAr/DAgK/xEMDvsTDhHfEAsO/g8KDf4OCgz/DQkM/w0JDP8NCQz/DAkM/w0KDv8JBgj/' +
  'BQMD/zcrS/96Yqz/ooPj/7SU9/+6nPv/waX//8qt///MsP//yK7//66Z1/9iWHT/CggK/wYEBv8MCAv/CwcJ/wsHCf8KBwn/' +
  'CgcJ/wsHCf4MCAr+EAoO3w4KDJsSDQ//DgoM/A0JC/8NCQv/DQkL/wwIC/8LCAr/CwgK/wwJDP8LCAv/AQAA/wMCAP8eGCb/' +
  'QjdU/11Pdv9rXYX/alyB/1dMaP81Lj7/DwwP/wAAAP8JBgn/CwgL/woHCf8LBwn/CgcJ/woHCP8KBwj/CwcJ/A4JDP8LCAqb' +
  'BQMELhINEPsOCgz8DgkM/g0JC/8MCAv/DAgK/wsICv8LCAr/CwgK/wsICv8LCAz/CwgL/wUDA/8AAAD/AAAA/wAAAP8AAAD/' +
  'AAAA/wEAAP8IBgj/DAkM/woHCf8KBwn/CgcJ/wsHCf8LBwn/CwcJ/woHCf4LBwn8DwoN+wQDAy4AAAAACggJhxINEP8OCQz5' +
  'DQkL/gwICv8MCAr/DAgK/wwICv8LCAr/CwgK/wsHCf8LBwr/DAgK/wwJDP8NCQ3/DQoN/w0KDf8NCgz/DAgL/wsHCv8KBwn/' +
  'CgcJ/wsHCf8LBwn/CwcJ/wsHCf8LBwn+CgcI+Q4JDP8IBgeHAAAAAAAAAAMAAAADDAkLrxEMD/8OCQz/DAgL/AwICv4NCAr/' +
  'DAgK/wwICv8MCAr/DAgK/wwICv8LBwr/CwcJ/wwICv8MCAr/CwgK/wsHCv8MCAr/DAgK/wwHCv8MBwr/DAcJ/wwHCv8LBwn+' +
  'CwcJ/AsHCf8OCQz/CwcJrwAAAAMAAAADAAAAAQAAAAEAAAACCgcIhw8LDvYPCg3/DgkL/w0JC/8NCAv/DQgK/w0ICv8NCAr/' +
  'DAgK/wwICv8MCAr/DQgK/w0ICv8MCAr/DAgK/w0ICv8NCAr/DAgK/wwHCv8MCAr/DAgK/wwICv8OCQv/DgkM9ggGB4cAAAAC' +
  'AAAAAQAAAAEAAAAAAAAAAQAAAAEAAAAABAMDMQwICpgQCg7cEQwO+REMD/4SDA//EQwP/xEMDv8RCw7/EQsO/xEMDv8RDA7/' +
  'EQwP/xEMD/8RDA//EQwO/xEMDv8QCw7/EQsO/xEMDv4RDA75DwoN3AsHCZgEAgMxAAAAAAAAAAEAAAABAAAAAA==';

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
  /** ADR-018:最近一次更新检查结果。有新版本时菜单顶部多一项下载入口 */
  private updateStatus: UpdateStatus | null = null;

  constructor(
    private readonly windowManager: WindowManager,
    private readonly sessionManager?: SessionManager,
    private readonly settingsManager?: SettingsManager,
  ) {}

  /**
   * 更新检查状态变化时由 index.ts 调用。只有"是否有新版本 / 哪个版本"变了才重建菜单,
   * 检查中、失败这些状态托盘不显示。
   */
  setUpdateStatus(status: UpdateStatus): void {
    const before = this.updateStatus?.update?.version ?? null;
    this.updateStatus = status;
    if ((status.update?.version ?? null) !== before) this.rebuildContextMenu();
  }

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

    // ADR-018:有新版本时放在最上面。点击用浏览器打开本机系统对应的安装包直链,
    // 不弹任何对话框,也不自动下载安装。
    const update = this.updateStatus?.update;
    if (update) {
      items.push({
        label: `有新版本 v${update.version},点击下载`,
        click: () => {
          shell
            .openExternal(update.downloadUrl)
            .catch((err) => logger.warn('TrayManager', 'open update download failed', err));
        },
      });
      items.push({ type: 'separator' });
    }

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
