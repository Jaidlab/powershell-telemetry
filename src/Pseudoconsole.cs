using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace PowerShellTelemetry
{
    // Owns only the handles created here. The caller owns its actual terminal handles.
    public sealed class Pseudoconsole : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)] public struct Coord
        {
            public short X, Y;
            public Coord(int x, int y) { X = checked((short)x); Y = checked((short)y); }
        }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public short Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct ScreenInfo
        {
            public Coord Size, Cursor; public short Attributes; public Rect Window; public Coord Maximum;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo
        {
            public int Size; public string Reserved, Desktop, Title;
            public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
            public short ShowWindow, ReservedBytes; public IntPtr ReservedPointer, StdInput, StdOutput, StdError;
        }
        [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
        [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
        [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console, Coord size);
        [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadFile(IntPtr file, byte[] buffer, uint length, out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteFile(IntPtr file, byte[] buffer, uint length, out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int handle);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr handle, uint mode);
        [DllImport("kernel32.dll")] public static extern uint GetConsoleCP();
        [DllImport("kernel32.dll")] public static extern uint GetConsoleOutputCP();
        [DllImport("kernel32.dll")] public static extern bool SetConsoleCP(uint codePage);
        [DllImport("kernel32.dll")] public static extern bool SetConsoleOutputCP(uint codePage);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out ScreenInfo info);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CancelIoEx(IntPtr handle, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint exitCode);

        IntPtr console, process;
        readonly FileStream input, output;
        readonly object inputLock = new object();
        public int ProcessId { get; }
        public Stream Output => output;
        public int ExitCode { get { if (!GetExitCodeProcess(process, out var code)) throw new Win32Exception(); return unchecked((int)code); } }
        public bool HasExited => WaitForSingleObject(process, 0) == 0;

        // Windows argv quoting, not PowerShell or cmd.exe quoting.
        public static string Quote(string argument)
        {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in argument)
            {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }

        public Pseudoconsole(string executable, string[] arguments, string cwd, IDictionary overrides, int columns = 120, int rows = 30)
        {
            IntPtr readInput = IntPtr.Zero, writeInput = IntPtr.Zero, readOutput = IntPtr.Zero, writeOutput = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero, environment = IntPtr.Zero;
            bool initialized = false;
            try
            {
                if (!CreatePipe(out readInput, out writeInput, IntPtr.Zero, 0) || !CreatePipe(out readOutput, out writeOutput, IntPtr.Zero, 0)) throw new Win32Exception();
                Marshal.ThrowExceptionForHR(CreatePseudoConsole(new Coord(columns, rows), readInput, writeOutput, 0, out console));
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception();
                initialized = true;
                if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020016), console, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (DictionaryEntry item in Environment.GetEnvironmentVariables()) variables[(string)item.Key] = (string)item.Value;
                if (overrides != null) foreach (DictionaryEntry item in overrides) variables[(string)item.Key] = Convert.ToString(item.Value);
                environment = Marshal.StringToHGlobalUni(string.Join("\0", variables.Select(item => item.Key + "=" + item.Value)) + "\0\0");
                var startup = new StartupInfoEx { Info = new StartupInfo { Size = Marshal.SizeOf<StartupInfoEx>(), Flags = 0x00000100 }, Attributes = attributes };
                var command = new StringBuilder(string.Join(" ", new[] { executable }.Concat(arguments).Select(Quote)));
                if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400, environment, cwd, ref startup, out var child)) throw new Win32Exception();
                process = child.Process; ProcessId = checked((int)child.ProcessId); CloseHandle(child.Thread);
                input = new FileStream(new SafeFileHandle(writeInput, true), FileAccess.Write, 4096, false); writeInput = IntPtr.Zero;
                output = new FileStream(new SafeFileHandle(readOutput, true), FileAccess.Read, 4096, false); readOutput = IntPtr.Zero;
            }
            catch
            {
                if (process != IntPtr.Zero) { TerminateProcess(process, 1); CloseHandle(process); process = IntPtr.Zero; }
                if (readOutput != IntPtr.Zero) { CloseHandle(readOutput); readOutput = IntPtr.Zero; }
                if (console != IntPtr.Zero) { ClosePseudoConsole(console); console = IntPtr.Zero; }
                throw;
            }
            finally
            {
                // ConPTY must not inherit our extra references; EOF depends on closing these.
                foreach (var handle in new[] { readInput, writeInput, readOutput, writeOutput }) if (handle != IntPtr.Zero) CloseHandle(handle);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            }
        }
        public void Write(byte[] bytes) { lock (inputLock) { input.Write(bytes, 0, bytes.Length); input.Flush(); } }
        public void Resize(int columns, int rows) { if (console != IntPtr.Zero) Marshal.ThrowExceptionForHR(ResizePseudoConsole(console, new Coord(columns, rows))); }
        public bool Wait(int milliseconds) => WaitForSingleObject(process, unchecked((uint)milliseconds)) == 0;
        public void Kill() { if (process != IntPtr.Zero && !HasExited) TerminateProcess(process, 1); }
        public void Close() { var value = Interlocked.Exchange(ref console, IntPtr.Zero); if (value != IntPtr.Zero) ClosePseudoConsole(value); }
        public static int[] TerminalSize()
        {
            if (GetConsoleScreenBufferInfo(GetStdHandle(-11), out var info)) return new[] { Math.Max(1, info.Window.Right - info.Window.Left + 1), Math.Max(1, info.Window.Bottom - info.Window.Top + 1) };
            return new[] { 120, 30 };
        }
        public static void WriteAll(IntPtr handle, byte[] data)
        {
            int offset = 0;
            while (offset < data.Length)
            {
                byte[] buffer = offset == 0 ? data : data.AsSpan(offset).ToArray();
                if (!WriteFile(handle, buffer, (uint)buffer.Length, out var written, IntPtr.Zero) || written == 0) throw new Win32Exception();
                offset += checked((int)written);
            }
        }
        public void Dispose()
        {
            Close();
            input?.Dispose(); output?.Dispose();
            var value = Interlocked.Exchange(ref process, IntPtr.Zero); if (value != IntPtr.Zero) CloseHandle(value);
        }
    }
}
