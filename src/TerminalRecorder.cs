using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PowerShellTelemetry
{
    // The journal is authoritative. Previews are bounded; the recorded bytes are not.
    public sealed class TerminalRecorder : IDisposable
    {
        const int MaxControlBytes = 16 * 1024 * 1024;
        readonly byte[] prefix;
        readonly Action<byte[]> display;
        readonly FileStream journal;
        readonly string directory, sessionId;
        readonly List<byte> pending = new List<byte>();
        readonly object gate = new object();
        readonly Stopwatch elapsed = Stopwatch.StartNew();
        long sequence;
        ActiveCommand active;
        public string Error { get; private set; }
        public long LostRecords { get; private set; }
        public bool HookReady { get; private set; }
        public long Sequence => sequence;
        public long Position => journal.Position;
        public string ActiveId => active?.Id;

        sealed class ActiveCommand : IDisposable
        {
            public string Id;
            public bool ExitsShell;
            public long Started, Bytes, Chunks;
            public readonly IncrementalHash Hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            public readonly Decoder Decoder = new UTF8Encoding(false, false).GetDecoder();
            public readonly BoundedText Preview = new BoundedText();
            public void Dispose() { Hash.Dispose(); }
        }
        public TerminalRecorder(string directory, string token, Action<byte[]> display)
        {
            this.directory = directory;
            sessionId = Path.GetFileName(directory);
            this.display = display;
            prefix = Encoding.ASCII.GetBytes("\u001b]633;PST;" + token + ";");
            Directory.CreateDirectory(directory);
            Directory.CreateDirectory(Path.Combine(directory, "requests"));
            journal = new FileStream(Path.Combine(directory, "events.jsonl"), FileMode.CreateNew, FileAccess.Write, FileShare.Read, 65536);
        }
        public static void AtomicJson(string file, object value)
        {
            string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, JsonSerializer.Serialize(value), new UTF8Encoding(false));
                File.Move(temporary, file, true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        void Store(Dictionary<string, object> value, bool durable = false)
        {
            try
            {
                value["version"] = 2; value["sessionId"] = sessionId; value["sequence"] = ++sequence;
                if (!value.ContainsKey("time")) value["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                byte[] bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + "\n");
                journal.Write(bytes, 0, bytes.Length);
                journal.Flush(durable);
            }
            catch (Exception error)
            {
                LostRecords++;
                Report(error.Message);
            }
        }
        public void Fail(string message) { lock (gate) Report(message); }
        void Report(string message)
        {
            bool first = Error == null;
            Error = message;
            if (first) { try { display(Encoding.UTF8.GetBytes("\r\n[powershell-telemetry] Recording error: " + message + ". Check Get-PowerShellTelemetryStatus.\r\n")); } catch { } }
        }
        void Output(byte[] bytes)
        {
            if (bytes.Length == 0) return;
            if (active == null) { display(bytes); return; } // Do not archive line editing, prompts or unsubmitted input.
            var characters = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
            int count = active.Decoder.GetChars(bytes, 0, bytes.Length, characters, 0, false);
            active.Preview.Append(new string(characters, 0, count));
            active.Hash.AppendData(bytes);
            for (int offset = 0; offset < bytes.Length; offset += 4096)
            {
                int size = Math.Min(4096, bytes.Length - offset);
                Store(new Dictionary<string, object> {
                    ["type"] = "output", ["id"] = active.Id, ["index"] = active.Chunks++,
                    ["offset"] = active.Bytes, ["bytes"] = size,
                    ["data"] = Convert.ToBase64String(bytes, offset, size)
                });
                active.Bytes += size;
            }
            display(bytes);
        }
        void Complete(Dictionary<string, object> data)
        {
            if (active == null) return;
            var chars = new char[4];
            int count = active.Decoder.GetChars(Array.Empty<byte>(), 0, 0, chars, 0, true);
            active.Preview.Append(new string(chars, 0, count));
            data["type"] = "complete"; data["id"] = active.Id;
            data["durationMs"] = Math.Max(0, elapsed.ElapsedMilliseconds - active.Started);
            data["terminalBytes"] = active.Bytes; data["terminalChunks"] = active.Chunks;
            data["terminalSha256"] = Convert.ToHexString(active.Hash.GetHashAndReset()).ToLowerInvariant();
            data["terminalPreview"] = active.Preview.ToString();
            data["terminalPreviewTruncated"] = active.Preview.Truncated;
            data["captureError"] = Error; data["lostRecords"] = LostRecords;
            Store(data, true);
            active.Dispose(); active = null;
        }
        static Dictionary<string, object> Properties(JsonElement element)
        {
            var result = new Dictionary<string, object>();
            foreach (var property in element.EnumerateObject()) result[property.Name] = property.Value.Clone();
            return result;
        }
        bool Control(byte[] encoded)
        {
            try
            {
                using var json = JsonDocument.Parse(Convert.FromBase64String(Encoding.ASCII.GetString(encoded)));
                var root = json.RootElement;
                string type = root.GetProperty("type").GetString();
                if (type == "fault")
                {
                    Report("Shell lifecycle hook: " + root.GetProperty("message").GetString());
                    if (active != null) Complete(new Dictionary<string, object> { ["resultKnown"] = false, ["outcome"] = "interrupted", ["reason"] = "Shell lifecycle observation failed." });
                    var value = Properties(root); value["type"] = "capture.error"; value["captureError"] = Error; Store(value, true);
                }
                else if (type == "ready")
                {
                    HookReady = true;
                    var value = Properties(root); value["type"] = "session.ready"; Store(value, true);
                }
                else if (type == "start")
                {
                    string id = root.GetProperty("id").GetString();
                    if (!Guid.TryParseExact(id, "N", out _)) return false;
                    if (active != null) Complete(new Dictionary<string, object> { ["resultKnown"] = false, ["outcome"] = "interrupted", ["reason"] = "Another command started before completion." });
                    active = new ActiveCommand { Id = id, Started = elapsed.ElapsedMilliseconds, ExitsShell = root.TryGetProperty("exitsShell", out var exit) && exit.GetBoolean() };
                    var value = Properties(root); value["capture"] = "terminal-vt"; Store(value, true);
                }
                else if (type == "complete")
                {
                    if (active == null || root.GetProperty("id").GetString() != active.Id) return false;
                    Complete(Properties(root));
                }
                else if (type == "sync")
                {
                    string id = root.GetProperty("requestId").GetString();
                    if (!Guid.TryParseExact(id, "N", out _)) return false;
                    Store(new Dictionary<string, object> { ["type"] = "barrier", ["requestId"] = id }, true);
                    AtomicJson(Path.Combine(directory, "requests", id + ".json"), new {
                        requestId = id, through = journal.Position, timeout = root.GetProperty("timeout").GetInt32(),
                        time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    });
                }
                else return false;
                return true;
            }
            catch (Exception error) { Report("Invalid lifecycle frame: " + error.Message); return false; }
        }
        int PrefixAt()
        {
            for (int i = 0; i <= pending.Count - prefix.Length; i++)
            {
                int j = 0; while (j < prefix.Length && pending[i + j] == prefix[j]) j++;
                if (j == prefix.Length) return i;
            }
            return -1;
        }
        // Remove only our session-scoped framing. All other ANSI, OSC and binary bytes pass untouched.
        public void Feed(byte[] bytes)
        {
            lock (gate)
            {
                pending.AddRange(bytes);
                while (pending.Count > 0)
                {
                    int start = PrefixAt();
                    if (start == -1)
                    {
                        int retain = Math.Min(prefix.Length - 1, pending.Count);
                        while (retain > 0)
                        {
                            int i = 0; while (i < retain && pending[pending.Count - retain + i] == prefix[i]) i++;
                            if (i == retain) break;
                            retain--;
                        }
                        int emit = pending.Count - retain;
                        Output(pending.GetRange(0, emit).ToArray()); pending.RemoveRange(0, emit); return;
                    }
                    if (start > 0) { Output(pending.GetRange(0, start).ToArray()); pending.RemoveRange(0, start); }
                    int end = pending.IndexOf(7, prefix.Length);
                    if (end == -1)
                    {
                        if (pending.Count <= MaxControlBytes) return;
                        Report("Lifecycle frame exceeded 16 MB; it was not interpreted.");
                        Output(pending.ToArray()); pending.Clear(); return;
                    }
                    byte[] frame = pending.GetRange(0, end + 1).ToArray();
                    byte[] payload = pending.GetRange(prefix.Length, end - prefix.Length).ToArray();
                    pending.RemoveRange(0, end + 1);
                    if (!Control(payload)) Output(frame);
                }
            }
        }
        public void Resize(int columns, int rows)
        {
            lock (gate) Store(new Dictionary<string, object> { ["type"] = "resize", ["id"] = active?.Id, ["columns"] = columns, ["rows"] = rows });
        }
        public void PublishStatus()
        {
            lock (gate)
            {
                try { AtomicJson(Path.Combine(directory, "capture.json"), new {
                    time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), active = active?.Id,
                    sequence, bytes = journal.Position, hookReady = HookReady, lostRecords = LostRecords, error = Error
                }); } catch (Exception error) { Report("Could not publish capture status: " + error.Message); }
            }
        }
        public void EndSession(int code)
        {
            lock (gate)
            {
                Output(pending.ToArray()); pending.Clear();
                if (active != null)
                {
                    var value = new Dictionary<string, object> { ["shellExitCode"] = code, ["resultKnown"] = active.ExitsShell, ["outcome"] = active.ExitsShell ? (code == 0 ? "success" : "error") : "interrupted" };
                    if (active.ExitsShell) { value["resultCode"] = code; value["success"] = code == 0; }
                    Complete(value);
                }
                Store(new Dictionary<string, object> { ["type"] = "session.end", ["exitCode"] = code, ["lostRecords"] = LostRecords, ["captureError"] = Error }, true);
                PublishStatus();
            }
        }
        public void Dispose() { active?.Dispose(); journal.Dispose(); }
    }

    public sealed class BoundedText
    {
        public const int Limit = 16384;
        readonly StringBuilder head = new StringBuilder();
        readonly Queue<Rune> tail = new Queue<Rune>();
        int headBytes, tailBytes;
        bool headSealed;
        public long TotalBytes { get; private set; }
        public int CapturedBytes => headBytes + tailBytes;
        public bool Truncated => TotalBytes > CapturedBytes;
        public void Append(string value)
        {
            foreach (var rune in value.EnumerateRunes())
            {
                int bytes = rune.Utf8SequenceLength; TotalBytes += bytes;
                if (!headSealed && headBytes + bytes <= Limit / 2) { head.Append(rune.ToString()); headBytes += bytes; continue; }
                headSealed = true; tail.Enqueue(rune); tailBytes += bytes;
                while (CapturedBytes > Limit) tailBytes -= tail.Dequeue().Utf8SequenceLength;
            }
        }
        public override string ToString() { var result = new StringBuilder(head.ToString()); foreach (var rune in tail) result.Append(rune.ToString()); return result.ToString(); }
    }
}
