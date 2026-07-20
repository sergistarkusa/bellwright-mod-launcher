using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class BellwrightUpdateHandoff
{
    private const uint CreateNoWindow = 0x08000000;
    private const int StartfUseShowWindow = 0x00000001;
    private const short SwHide = 0;
    private const uint MbIconError = 0x00000010;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        var result = new StringBuilder(value.Length + 2);
        result.Append('"');
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }

            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }

            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void AppendLog(string logPath, string message)
    {
        try
        {
            var parent = Path.GetDirectoryName(logPath);
            if (!string.IsNullOrEmpty(parent))
            {
                Directory.CreateDirectory(parent);
            }
            File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
        }
        catch
        {
            // The updater can still report its own failures after the handoff starts.
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string logPath = null;
        try
        {
            if (args.Length < 4 || !string.Equals(args[0], "--log", StringComparison.Ordinal))
            {
                throw new ArgumentException("Expected --log <path> <program> [arguments].");
            }

            logPath = Path.GetFullPath(args[1]);
            var program = Path.GetFullPath(args[2]);
            if (!File.Exists(program))
            {
                throw new FileNotFoundException("Update program was not found.", program);
            }

            var commandLine = new StringBuilder(QuoteArgument(program));
            for (var index = 3; index < args.Length; index++)
            {
                commandLine.Append(' ');
                commandLine.Append(QuoteArgument(args[index]));
            }

            var startupInfo = new StartupInfo
            {
                cb = Marshal.SizeOf(typeof(StartupInfo)),
                dwFlags = StartfUseShowWindow,
                wShowWindow = SwHide,
                hStdInput = IntPtr.Zero,
                hStdOutput = IntPtr.Zero,
                hStdError = IntPtr.Zero
            };

            ProcessInformation processInformation;
            if (!CreateProcessW(
                program,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CreateNoWindow,
                IntPtr.Zero,
                Path.GetTempPath(),
                ref startupInfo,
                out processInformation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the hidden updater process.");
            }

            try
            {
                AppendLog(logPath, "GUI-safe handoff started updater process " + processInformation.dwProcessId + ".");
            }
            finally
            {
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);
            }
            return 0;
        }
        catch (Exception error)
        {
            if (!string.IsNullOrEmpty(logPath))
            {
                AppendLog(logPath, "Update handoff failed: " + error.Message);
            }
            MessageBoxW(IntPtr.Zero, error.Message, "Bellwright Mod Launcher update failed", MbIconError);
            return 1;
        }
    }
}
