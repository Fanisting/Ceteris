/**
 * @file src/shared/remote-path.ts
 * @purpose 提供远程路径字符串的统一规范化逻辑,供 PathManager 与
 *   SshProfileManager 共用。
 *
 * @关键设计:
 * - 远程路径不是本机文件系统路径,不能走 node:path.resolve()
 * - 只做跨 shell / SSH 场景稳定且可解释的文本规范化
 * - 空输入按远程 home 简写 "~" 处理,匹配 Ceteris 远程默认 cwd
 *
 * @对应文档章节: 软件定义书.md 第 5.1.1、5.1.6、11.1 节
 *
 * @不要在这里做的事:
 * - 不校验远程路径是否存在(需要连接远端,不是纯规范化职责)
 * - 不决定 home 是什么(由调用方传入,见 expandHome)
 * - 不处理本地路径(本地路径由 PathManager.normalizePath 负责)
 */

/**
 * 把 SSH / WSL 等远程路径输入规范化成稳定文本。
 *
 * @param input 用户输入、导入归档或持久化文件中的远程路径
 * @returns 规范化后的远程路径;空白输入返回 "~"
 *
 * @副作用:无
 */
export function normalizeRemotePath(input: string): string {
  let value = input.trim();
  if (!value) value = '~';
  value = value.replace(/\\/g, '/');
  value = value.replace(/\/+/g, '/');
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export function joinRemotePath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** 把开头的 ~ 换成 home。"~user" 这种写法不是 Ceteris 产生的,原样返回。 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? joinRemotePath(home, path.slice(2)) : path;
}

export function remoteDirname(path: string): string {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return '.';
  return cut === 0 ? '/' : path.slice(0, cut);
}
