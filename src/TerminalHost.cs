using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace PowerShellTelemetry
{
    public static class TerminalHost
    {
        // No PowerShell callbacks run on worker threads. Console I/O, resize and disk capture are independent of delivery.
        public static int Run(string sourceDirectory, string shell, string bun, string directory, string endpoint, string serviceName, string[] childArguments)
        {
            var stdin = Pseudoconsole.GetStdHandle(-10);
            var stdout = Pseudoconsole.GetStdHandle(-11);
            uint inputMode, outputMode;
            bool inputConsole = Pseudoconsole.GetConsoleMode(stdin, out inputMode);
            bool outputConsole = Pseudoconsole.GetConsoleMode(stdout, out outputMode);
            uint inputCodePage = Pseudoconsole.GetConsoleCP(), outputCodePage = Pseudoconsole.GetConsoleOutputCP();
            string token = Guid.NewGuid().ToString("N");
            var size = Pseudoconsole.TerminalSize();
            Pseudoconsole terminal = null;
            Process agent = null;
            FileStream agentLog = null;
            Task agentOut = null, agentError = null;
            Thread input = null, output = null;
            bool stopping = false;
            Exception outputFailure = null;
            int code = 1;
            using var recorder = new TerminalRecorder(directory, token, bytes => Pseudoconsole.WriteAll(stdout, bytes));
            try
            {
                if (inputConsole)
                {
                    // Raw VT input forwards Ctrl+C, keys, mouse and bracketed paste to the real child console.
                    if (!Pseudoconsole.SetConsoleMode(stdin, (inputMode & ~(uint)(1 | 2 | 4 | 0x40)) | 0x200 | 0x80)) throw new System.ComponentModel.Win32Exception();
                    Pseudoconsole.SetConsoleCP(65001);
                }
                if (outputConsole)
                {
                    if (!Pseudoconsole.SetConsoleMode(stdout, outputMode | 4)) throw new System.ComponentModel.Win32Exception();
                    Pseudoconsole.SetConsoleOutputCP(65001);
                }
                var environment = new Hashtable {
                    ["POWERSHELL_TELEMETRY_SESSION"] = directory,
                    ["POWERSHELL_TELEMETRY_TOKEN"] = token
                };
                terminal = new Pseudoconsole(shell, childArguments, Environment.CurrentDirectory, environment, size[0], size[1]);
                TerminalRecorder.AtomicJson(Path.Combine(directory, "manifest.json"), new {
                    version = 2, sessionId = Path.GetFileName(directory), endpoint, serviceName,
                    host = Environment.MachineName, user = Environment.UserName,
                    hostPid = Environment.ProcessId, shellPid = terminal.ProcessId,
                    startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), columns = size[0], rows = size[1]
                });
                output = new Thread(() => {
                    try
                    {
                        var buffer = new byte[16384];
                        int length;
                        while ((length = terminal.Output.Read(buffer, 0, buffer.Length)) > 0) recorder.Feed(buffer.AsSpan(0, length).ToArray());
                    }
                    catch (Exception error) { outputFailure = error; }
                }) { IsBackground = true, Name = "PowerShell telemetry terminal output" };
                output.Start();
                input = new Thread(() => {
                    try
                    {
                        var buffer = new byte[4096];
                        while (!Volatile.Read(ref stopping) && Pseudoconsole.ReadFile(stdin, buffer, (uint)buffer.Length, out var length, IntPtr.Zero) && length > 0)
                            terminal.Write(buffer.AsSpan(0, checked((int)length)).ToArray());
                    }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                }) { IsBackground = true, Name = "PowerShell telemetry terminal input" };
                input.Start();
                try
                {
                    var info = new ProcessStartInfo(bun) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                    info.ArgumentList.Add(Path.Combine(sourceDirectory, "agent.ts"));
                    info.ArgumentList.Add("--session"); info.ArgumentList.Add(directory); info.ArgumentList.Add("--follow");
                    agent = Process.Start(info);
                    // The agent uses stderr for diagnostics only. Both pipes are always drained.
                    agentLog = new FileStream(Path.Combine(directory, "agent.log"), FileMode.Append, FileAccess.Write, FileShare.Read);
                    agentError = agent.StandardError.BaseStream.CopyToAsync(agentLog);
                    agentOut = agent.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
                }
                catch (Exception error)
                {
                    Pseudoconsole.WriteAll(stdout, Encoding.UTF8.GetBytes("\r\n[powershell-telemetry] Exporter could not start: " + error.Message + ". Output is still archived in " + directory + ".\r\n"));
                }
                bool warnedAgent = agent == null;
                long lastStatus = 0;
                long launchedAt = Environment.TickCount64;
                bool warnedHook = false;
                while (!terminal.Wait(100))
                {
                    if (outputFailure != null) throw new IOException("The terminal output reader failed.", outputFailure);
                    if (outputConsole)
                    {
                        var next = Pseudoconsole.TerminalSize();
                        if (next[0] != size[0] || next[1] != size[1])
                        {
                            terminal.Resize(next[0], next[1]); recorder.Resize(next[0], next[1]); size = next;
                        }
                    }
                    long now = Environment.TickCount64;
                    if (now - lastStatus >= 1000)
                    {
                        recorder.PublishStatus(); lastStatus = now;
                        if (!warnedHook && !recorder.HookReady && now - launchedAt > 30000)
                        {
                            warnedHook = true;
                            recorder.Fail("The interactive lifecycle hook has not started within 30 seconds. Command attribution is unavailable.");
                        }
                        if (!warnedAgent && agent.HasExited)
                        {
                            warnedAgent = true;
                            Pseudoconsole.WriteAll(stdout, Encoding.UTF8.GetBytes("\r\n[powershell-telemetry] Exporter stopped. The full local journal is retained; inspect " + directory + ".\r\n"));
                        }
                    }
                }
                code = terminal.ExitCode;
            }
            finally
            {
                Volatile.Write(ref stopping, true);
                try
                {
                    if (terminal != null)
                    {
                        // Closing must not run on the reader thread; ConPTY can emit a final frame.
                        var closing = Task.Run(() => terminal.Close());
                        if (!closing.Wait(10000)) recorder.Fail("ConPTY did not close within 10 seconds.");
                        if (output != null && !output.Join(10000)) recorder.Fail("The terminal output reader did not finish draining.");
                    }
                    if (outputFailure != null) recorder.Fail("Terminal output reader failed: " + outputFailure.Message);
                    if (!recorder.HookReady) recorder.Fail("The shell exited without initializing its lifecycle hook.");
                    try { recorder.EndSession(code); } catch (Exception error) { recorder.Fail("Could not finalize the journal: " + error.Message); }
                    if (agent != null)
                    {
                        if (!agent.WaitForExit(2500)) agent.Kill();
                        agent.WaitForExit(1000);
                        try { Task.WhenAll(agentOut ?? Task.CompletedTask, agentError ?? Task.CompletedTask).Wait(1000); } catch { }
                        agent.Dispose();
                    }
                }
                finally
                {
                    try
                    {
                        agentLog?.Dispose();
                        Pseudoconsole.CancelIoEx(stdin, IntPtr.Zero);
                        if (input != null) input.Join(100);
                        terminal?.Dispose();
                    }
                    finally
                    {
                        if (inputConsole) { Pseudoconsole.SetConsoleMode(stdin, inputMode); Pseudoconsole.SetConsoleCP(inputCodePage); }
                        if (outputConsole) { Pseudoconsole.SetConsoleMode(stdout, outputMode); Pseudoconsole.SetConsoleOutputCP(outputCodePage); }
                    }
                }
            }
            return code;
        }
    }
}
