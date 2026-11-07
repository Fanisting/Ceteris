/**
 * @file src/main/platform/askpass-helper-source.ts
 * @purpose Windows 上 SSH_ASKPASS 助手程序的 C# 源码。WindowsAdapter.prepareSshAskpass 第一次
 *   用到时,用 Windows 自带的 .NET Framework 编译器(csc.exe)把它编成一个 5 KB 的 exe。
 *
 * @关键设计:
 * - 为什么要编译一个 exe:ssh 只接受可执行文件做 SSH_ASKPASS。
 *   - .cmd 不行:Windows 让 cmd.exe 解释它,服务器发来的提示文本会出现在 cmd 的命令行上,
 *     `"` 能跳出引号,`&calc` 就执行了(CVE-2024-24576 的形态)。
 *   - Ceteris.exe 自己不行:Electron 的浏览器进程在 Windows 上启动时无条件往 stdout 写一个
 *     换行(electron_main_delegate.cc,"prevent output in the same line as the prompt"),
 *     而 ssh 读到第一个换行就截断,答案永远是空串。
 *   - csc.exe 是 .NET Framework 4.x 的一部分,Windows 10 / 11 自带,路径固定,只支持 C# 5,
 *     所以下面的代码不用新语法。编译一次约 0.2 秒,产物按源码哈希命名,改了源码自动重编。
 * - 助手做的事只有传话:读环境变量里的管道名和令牌,把 argv 里的提示发给 Ceteris,
 *   把答案原样写到 stdout(不带换行),任何失败都退出 1 让 ssh 当作没有输入。
 *   协议见 askpass.ts,JSON 用 .NET 自带的 JavaScriptSerializer。
 * - 这是一个字符串常量而不是 .cs 文件:main 进程的打包不需要额外配置,
 *   哈希也直接从这个字符串算。
 *
 * @对应文档章节: 软件定义书.md 14.9、ADR-016
 *
 * @不要在这里做的事:
 * - 不要在助手里判断提示或保存密码,它只负责传话
 * - 不要用 C# 6 以上的语法($"..."、?. 等),csc 4.0.30319 编不过
 */

export const ASKPASS_HELPER_SOURCE = `// Ceteris SSH_ASKPASS helper. Generated from src/main/platform/askpass-helper-source.ts.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Web.Script.Serialization;

static class CeterisAskpass
{
    static int Main(string[] args)
    {
        string pipe = Environment.GetEnvironmentVariable("CETERIS_ASKPASS_PIPE");
        string token = Environment.GetEnvironmentVariable("CETERIS_ASKPASS_TOKEN");
        if (string.IsNullOrEmpty(pipe) || string.IsNullOrEmpty(token)) return 1;
        string hint = Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT");
        // ssh puts the prompt in the first argument. Join in case a build ever leaves it unquoted.
        string prompt = string.Join(" ", args);
        const string prefix = @"\\\\.\\pipe\\";
        string name = pipe.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? pipe.Substring(prefix.Length)
            : pipe;
        try
        {
            using (var client = new NamedPipeClientStream(".", name, PipeDirection.InOut))
            {
                client.Connect(15000);
                var serializer = new JavaScriptSerializer();
                var request = new Dictionary<string, object>();
                request["v"] = 1;
                request["token"] = token;
                request["prompt"] = prompt;
                request["hint"] = hint;
                byte[] bytes = Encoding.UTF8.GetBytes(serializer.Serialize(request) + "\\n");
                client.Write(bytes, 0, bytes.Length);
                client.Flush();
                var buffer = new MemoryStream();
                int b;
                while ((b = client.ReadByte()) != -1)
                {
                    if (b == '\\n') break;
                    buffer.WriteByte((byte)b);
                    if (buffer.Length > 65536) return 1;
                }
                if (buffer.Length == 0) return 1;
                var reply = serializer.Deserialize<Dictionary<string, object>>(
                    Encoding.UTF8.GetString(buffer.ToArray()));
                object answer;
                if (reply == null || !reply.TryGetValue("answer", out answer) || !(answer is string)) return 1;
                byte[] outBytes = Encoding.UTF8.GetBytes((string)answer);
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    stdout.Write(outBytes, 0, outBytes.Length);
                    stdout.Flush();
                }
                return 0;
            }
        }
        catch (Exception)
        {
            return 1;
        }
    }
}
`;

/** csc.exe 的参数。单独拿出来是为了能测,不用真的编译。 */
export function buildCscArgs(sourcePath: string, exePath: string): string[] {
  return [
    '-nologo',
    '-target:exe',
    '-optimize+',
    '-platform:anycpu',
    `-out:${exePath}`,
    '-r:System.Web.Extensions.dll',
    sourcePath,
  ];
}
