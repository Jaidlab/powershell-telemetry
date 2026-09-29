using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Runtime.InteropServices;

namespace PowerShellTelemetry
{
    // This is a control channel, not an output interceptor. Child applications keep their console handles.
    public static class Capture
    {
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
        static string session, token;
        static readonly object gate = new object();
        static readonly HashSet<object> previousErrors = new HashSet<object>(ReferenceEqualityComparer.Instance);
        static readonly List<string> nativeLookups = new List<string>();
        public static string ActiveId { get; private set; }
        public static string LastError { get; private set; }
        public static string SessionPath => session;
        public static void Configure(string sessionPath, string secret)
        {
            if (session != null) return;
            if (string.IsNullOrEmpty(secret) || !Directory.Exists(sessionPath)) throw new ArgumentException("A hosted telemetry session is required.");
            session = sessionPath; token = secret;

        }
        // Process launchers can pass down the inheritable ignore-Ctrl+C flag. A fresh terminal must clear it.
        public static void InitializeConsole()
        {
            if (!SetConsoleCtrlHandler(IntPtr.Zero, false)) throw new System.ComponentModel.Win32Exception();
        }
        public static void Fail(string message)
        {
            LastError = message;
            Send(JsonSerializer.Serialize(new { type = "fault", message }));
            End();
        }
        public static void Send(string json)
        {
            try
            {
                byte[] frame = Encoding.ASCII.GetBytes("\u001b]633;PST;" + token + ";" + Convert.ToBase64String(Encoding.UTF8.GetBytes(json)) + "\u0007");
                lock (gate)
                {
                    using var output = Console.OpenStandardOutput();
                    output.Write(frame, 0, frame.Length); output.Flush();
                }
            }
            catch (Exception error)
            {
                LastError = error.Message;
                try { Console.Error.WriteLine("[powershell-telemetry] Lifecycle capture failed: " + error.Message); } catch { }
            }
        }
        public static string Begin(IEnumerable errors)
        {
            previousErrors.Clear(); nativeLookups.Clear();
            foreach (var error in errors) previousErrors.Add(error);
            ActiveId = Guid.NewGuid().ToString("N");
            return ActiveId;
        }
        public static void NativeLookup(string file) { if (ActiveId != null) nativeLookups.Add(file); }
        public static string[] NativeLookups => nativeLookups.ToArray();
        public static object[] NewErrors(IEnumerable errors)
        {
            var result = new List<object>();
            foreach (var error in errors) if (!previousErrors.Contains(error)) result.Add(error);
            return result.ToArray();
        }
        public static void End() { ActiveId = null; previousErrors.Clear(); nativeLookups.Clear(); }
        public static string ReadStatus(string file)
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            return reader.ReadToEnd();
        }
        public static bool Sync(int timeout)
        {
            if (timeout < 1 || timeout > 600000) throw new ArgumentOutOfRangeException(nameof(timeout));
            string id = Guid.NewGuid().ToString("N");
            string file = Path.Combine(session, "requests", id + ".response.json");
            Send(JsonSerializer.Serialize(new { type = "sync", requestId = id, timeout }));
            long deadline = Environment.TickCount64 + timeout + 250;
            try
            {
                while (Environment.TickCount64 < deadline)
                {
                    if (File.Exists(file))
                    {
                        using var response = JsonDocument.Parse(File.ReadAllText(file));
                        if (response.RootElement.GetProperty("requestId").GetString() != id) throw new InvalidDataException("Mismatched telemetry response.");
                        bool complete = response.RootElement.GetProperty("complete").GetBoolean();
                        LastError = complete ? null : "Telemetry has pending, rejected or unrecorded data. Inspect the session status and journal.";
                        return complete;
                    }
                    Thread.Sleep(20);
                }
                LastError = "Telemetry synchronization timed out; the local journal remains available.";
                return false;
            }
            catch (Exception error) { LastError = error.Message; return false; }
            finally { try { File.Delete(file); } catch { } }
        }
    }
}
