/**
 * @file src/main/platform/askpass-helper-source.test.ts
 * @purpose 助手源码和编译参数的形态检查。不真的调 csc.exe(AGENTS.md 9.3)。
 */
import { describe, expect, it } from 'vitest';
import { ASKPASS_HELPER_SOURCE, buildCscArgs } from './askpass-helper-source';
import { ASKPASS_PIPE_ENV, ASKPASS_TOKEN_ENV } from './askpass';

describe('askpass 助手源码', () => {
  it('读的环境变量和 askpass.ts 的约定一致', () => {
    expect(ASKPASS_HELPER_SOURCE).toContain(`"${ASKPASS_PIPE_ENV}"`);
    expect(ASKPASS_HELPER_SOURCE).toContain(`"${ASKPASS_TOKEN_ENV}"`);
    expect(ASKPASS_HELPER_SOURCE).toContain('"SSH_ASKPASS_PROMPT"');
  });

  it('模板字符串的转义落到 C# 里是对的:管道前缀和换行', () => {
    expect(ASKPASS_HELPER_SOURCE).toContain('@"\\\\.\\pipe\\"');
    expect(ASKPASS_HELPER_SOURCE).toContain('+ "\\n"');
    expect(ASKPASS_HELPER_SOURCE).toContain("b == '\\n'");
  });

  it('不用 C# 6 以上的语法,csc 4.0.30319 才编得过', () => {
    expect(ASKPASS_HELPER_SOURCE).not.toMatch(/\$"/);
    expect(ASKPASS_HELPER_SOURCE).not.toMatch(/\?\./);
    expect(ASKPASS_HELPER_SOURCE).not.toMatch(/=>/);
    expect(ASKPASS_HELPER_SOURCE).not.toContain('nameof(');
  });

  it('答案不带换行地写到 stdout,失败一律退出 1', () => {
    expect(ASKPASS_HELPER_SOURCE).toContain('Console.OpenStandardOutput()');
    expect(ASKPASS_HELPER_SOURCE).not.toContain('Console.WriteLine');
    expect(ASKPASS_HELPER_SOURCE).not.toContain('Console.Write(');
    expect(ASKPASS_HELPER_SOURCE.match(/return 1;/g)?.length).toBeGreaterThan(3);
  });
});

describe('buildCscArgs', () => {
  it('编成 anycpu 的 exe,引用 JSON 序列化所在的程序集', () => {
    const args = buildCscArgs('C:\\d\\a.cs', 'C:\\d\\a.exe');
    expect(args).toEqual([
      '-nologo',
      '-target:exe',
      '-optimize+',
      '-platform:anycpu',
      '-out:C:\\d\\a.exe',
      '-r:System.Web.Extensions.dll',
      'C:\\d\\a.cs',
    ]);
  });
});
