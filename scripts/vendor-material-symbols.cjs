#!/usr/bin/env node
/**
 * @file scripts/vendor-material-symbols.cjs
 * @purpose 把 Ceteris 实际用到的 Material Symbols (Rounded) 拉取下来,生成
 *   src/renderer/components/material-symbols.tsx。
 *
 * @关键设计:
 * - 运行时零依赖:图标路径直接落在生成文件里,应用不用 icon font,也不装 npm 包
 *   (AGENTS.md 1.2 边界 2)。只有开发者加图标时才需要跑本脚本,才需要联网。
 * - 下载内容是外部数据:只从 SVG 里提取第一个 path 的 d 属性,并校验其只含路径
 *   指令字符,其它内容一律丢弃,所以 SVG 里的任何标记都进不了 bundle。
 *
 * @用法:
 *   1. 在下方 SYMBOLS 加一行 [导出名, Material Symbols 名, 轴变体]
 *   2. npm run vendor-symbols
 *   3. 把生成文件和本脚本一起提交
 *
 * @轴变体:'default' 是 weight 400 / outlined;'wght700' 用于 9px 以下的状态
 *   小图标,默认字重在这个尺寸下看不清;'fill1' 是实心版本。
 *
 * @常见问题排查:
 * - HTTP 404 → 符号名写错,到 https://fonts.google.com/icons 核对(用下划线名)
 * - "unexpected path data" → 上游文件结构变了,先人工看一眼下载到的 SVG
 *
 * Material Symbols 由 Google 以 Apache License 2.0 发布。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT_FILE = path.resolve(
  __dirname,
  '..',
  'src',
  'renderer',
  'components',
  'material-symbols.tsx',
);
const BASE_URL = 'https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded';
const VIEW_BOX = '0 -960 960 960';

/** [导出组件名, Material Symbols 名, 轴变体] */
const SYMBOLS = [
  // 窗口控制
  ['WindowMinimize', 'remove', 'default'],
  ['WindowMaximize', 'crop_square', 'default'],
  ['WindowRestore', 'filter_none', 'default'],
  ['Close', 'close', 'default'],

  // 通用
  ['Add', 'add', 'default'],
  ['Check', 'check', 'default'],
  ['CheckBold', 'check', 'wght700'],
  ['CloseBold', 'close', 'wght700'],
  ['ChevronRight', 'chevron_right', 'default'],
  ['ExpandMore', 'expand_more', 'default'],
  ['Warning', 'warning', 'default'],
  ['Info', 'info', 'default'],
  ['OpenInNew', 'open_in_new', 'default'],
  ['OpenInFull', 'open_in_full', 'default'],
  ['CloseFullscreen', 'close_fullscreen', 'default'],
  ['RadioChecked', 'radio_button_checked', 'default'],
  ['Search', 'search', 'default'],
  ['Settings', 'settings', 'default'],

  // 设置分类
  ['Palette', 'palette', 'default'],
  ['Tune', 'tune', 'default'],
  ['Database', 'database', 'default'],
  ['LinkIcon', 'link', 'default'],
  ['Psychology', 'psychology', 'default'],
  ['Build', 'build', 'default'],

  // 侧栏分类
  ['Bookmark', 'bookmark', 'default'],
  ['Schedule', 'schedule', 'default'],
  ['History', 'history', 'default'],
  ['Dns', 'dns', 'default'],
  // 文件夹列表 / 块视图切换
  ['GridView', 'grid_view', 'default'],
  ['ViewList', 'view_list', 'default'],
  ['ArrowBack', 'arrow_back', 'default'],

  // 终端右键
  ['ContentCopy', 'content_copy', 'default'],
  ['ContentPaste', 'content_paste', 'default'],
  ['InkEraser', 'ink_eraser', 'default'],

  // 模板与 shell
  ['Terminal', 'terminal', 'default'],
  ['Code', 'code', 'default'],
  ['Window', 'window', 'default'],
  ['ForkRight', 'fork_right', 'default'],
  ['AutoAwesome', 'auto_awesome', 'default'],
  ['Atr', 'atr', 'default'],
  ['DeployedCode', 'deployed_code', 'default'],

  // 文件树
  ['AccountTree', 'account_tree', 'default'],
  ['Folder', 'folder', 'default'],
  ['FolderOpen', 'folder_open', 'default'],
  ['Draft', 'draft', 'default'],
  // PDF 查看器工具栏
  ['ZoomIn', 'zoom_in', 'default'],
  ['ZoomOut', 'zoom_out', 'default'],
  ['FitWidth', 'fit_width', 'default'],
  ['Sync', 'sync', 'default'],
];

/** 只接受 SVG path 指令用到的字符,挡住任何混进 d 属性的非路径内容。 */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.\-eE]+$/;

/**
 * 下载一个符号并返回校验过的路径数据。
 *
 * @throws 下载失败或 SVG 结构不符合预期时抛错,脚本整体失败,不写半成品文件。
 */
async function fetchSymbol(name, axes) {
  const url = `${BASE_URL}/${name}/${axes}/24px.svg`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `[vendor-symbols] GET ${url} returned HTTP ${res.status}. ` +
        `Possible causes: (1) symbol name "${name}" is misspelled, ` +
        `(2) axes variant "${axes}" does not exist. ` +
        'Check the name at https://fonts.google.com/icons.',
    );
  }
  const svg = await res.text();
  const match = svg.match(/<path[^>]*\sd="([^"]+)"/);
  // 组件假定单一路径和固定坐标系,不符时必须报错,否则图标会缺一部分或错位
  const singlePath = (svg.match(/<path\b/g) ?? []).length === 1;
  if (!match || !singlePath || !svg.includes(`viewBox="${VIEW_BOX}"`) || !PATH_DATA.test(match[1])) {
    throw new Error(
      `[vendor-symbols] unexpected path data for "${name}" (${axes}). ` +
        `Possible causes: (1) upstream changed the SVG structure, ` +
        `(2) the response is not an SVG. First 120 chars: ${svg.slice(0, 120)}`,
    );
  }
  return match[1];
}

function renderFile(entries) {
  const header = `/**
 * @file src/renderer/components/material-symbols.tsx
 * @purpose Material Symbols (Rounded) 图标组件。本文件由
 *   scripts/vendor-material-symbols.cjs 生成,不要手改,改脚本的 SYMBOLS 后重跑
 *   npm run vendor-symbols。
 *
 * @关键设计:
 * - 图标是填充路径,不是描边:颜色走 currentColor,调粗细要换字重变体,
 *   CSS 的 stroke-width 对它们无效。
 * - 没有 aria-label 时标记 aria-hidden,避免屏幕阅读器读出无意义的图形。
 *
 * Material Symbols, Copyright Google LLC, Apache License 2.0。
 *
 * @对应文档章节: 软件定义书.md 10.1 节
 */
import type { ReactElement } from 'react';

export interface SymbolProps {
  size?: number;
  className?: string | undefined;
  'aria-label'?: string;
}

export type SymbolComponent = (props: SymbolProps) => ReactElement;

/** 用路径数据构造一个图标组件。viewBox 是 Material Symbols 导出的固定坐标系。 */
function createSymbol(d: string): SymbolComponent {
  return function MaterialSymbol({ size = 24, className, ...rest }: SymbolProps): ReactElement {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 -960 960 960"
        fill="currentColor"
        className={className}
        aria-hidden={rest['aria-label'] ? undefined : true}
        {...rest}
      >
        <path d={d} />
      </svg>
    );
  };
}
`;
  const exports = entries
    .map(([exportName, d]) => `export const ${exportName} = createSymbol(\n  '${d}',\n);`)
    .join('\n');
  return `${header}\n${exports}\n`;
}

async function main() {
  const entries = [];
  // 串行下载:符号数量很少,没必要为这点时间并发打外部服务。
  for (const [exportName, name, axes] of SYMBOLS) {
    entries.push([exportName, await fetchSymbol(name, axes)]);
    console.log(`[vendor-symbols] ${exportName} <- ${name} (${axes})`);
  }
  fs.writeFileSync(OUT_FILE, renderFile(entries));
  console.log(`[vendor-symbols] wrote ${OUT_FILE} (${entries.length} symbols)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
