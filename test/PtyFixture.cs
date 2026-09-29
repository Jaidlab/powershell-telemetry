using System;
using System.Collections;
using System.IO;
using System.Text;
using System.Threading;
using PowerShellTelemetry;

public sealed class PtyFixture : IDisposable
{
    readonly Pseudoconsole process;
    readonly Thread reader;
    readonly StringBuilder text = new StringBuilder();
    readonly object gate = new object();
    Exception failure;
    public PtyFixture(string executable, string[] arguments, string cwd, int columns, int rows)
    {
        process = new Pseudoconsole(executable, arguments, cwd, new Hashtable(), columns, rows);
        reader = new Thread(() => {
            try
            {
                using var input = new StreamReader(process.Output, new UTF8Encoding(false, false));
                var buffer = new char[4096];
                int length;
                while ((length = input.Read(buffer, 0, buffer.Length)) > 0) lock (gate) text.Append(buffer, 0, length);
            }
            catch (Exception error) { failure = error; }
        }) { IsBackground = true };
        reader.Start();
    }
    public string Text { get { lock (gate) return text.ToString(); } }
    public int ExitCode => process.ExitCode;
    public int ProcessId => process.ProcessId;
    public bool HasExited => process.HasExited;
    public void Write(string value) => process.Write(Encoding.UTF8.GetBytes(value));
    public void Resize(int columns, int rows) => process.Resize(columns, rows);
    public bool Wait(int timeout) => process.Wait(timeout);
    public void Dispose()
    {
        if (!process.HasExited) process.Kill();
        process.Close();
        reader.Join(10000);
        process.Dispose();
        if (failure != null) throw new IOException("Fixture terminal reader failed.", failure);
    }
}
