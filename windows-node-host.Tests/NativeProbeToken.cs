using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace MicroClaw.WindowsNodeHost.Tests;

internal sealed record NativeProbeToken(
    int Pid, bool ImageMatches, bool IsAppContainer, string? AppContainerSid,
    string IntegritySid, string[] Capabilities)
{
    internal static NativeProbeToken Inspect(int pid, string expectedImage)
    {
        using var process = OpenProcess(0x1000, false, pid);
        if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var image = new char[32768];
        var length = (uint)image.Length;
        if (!QueryFullProcessImageName(process, 0, image, ref length))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!OpenProcessToken(process, 8, out var token))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        using (token)
        {
            var isAppContainer = Query(token, 29, value => Marshal.ReadInt32(value) != 0);
            var sid = isAppContainer ? Query(token, 31, value =>
                new SecurityIdentifier(Marshal.ReadIntPtr(value)).Value) : null;
            var integrity = Query(token, 25, value =>
                new SecurityIdentifier(Marshal.ReadIntPtr(value)).Value);
            var capabilities = Query(token, 30, value =>
            {
                var count = Marshal.ReadInt32(value);
                if (count is < 0 or > 128) throw new InvalidOperationException("Invalid token capability count");
                var offset = Marshal.OffsetOf<TokenGroupHeader>(nameof(TokenGroupHeader.Sid)).ToInt32();
                var stride = Marshal.SizeOf<SidAndAttributes>();
                return Enumerable.Range(0, count).Select(index =>
                    new SecurityIdentifier(Marshal.ReadIntPtr(value, offset + index * stride)).Value).ToArray();
            });
            return new NativeProbeToken(pid,
                string.Equals(new string(image, 0, (int)length), expectedImage, StringComparison.OrdinalIgnoreCase),
                isAppContainer, sid, integrity, capabilities);
        }

    }

    internal static string ContainerSid(string name)
    {
        var status = DeriveAppContainerSid(name, out var sid);
        if (status != 0) throw new Win32Exception(status);
        try { return new SecurityIdentifier(sid).Value; }
        finally { FreeSid(sid); }
    }

    private static T Query<T>(SafeAccessTokenHandle token, int informationClass, Func<nint, T> project)
    {
        GetTokenInformation(token, informationClass, 0, 0, out var size);
        if (size is <= 0 or > 65536) throw new Win32Exception(Marshal.GetLastWin32Error());
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!GetTokenInformation(token, informationClass, buffer, size, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return project(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public nint Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenGroupHeader { public uint Count; public nint Sid; public uint Attributes; }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, char[] image, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int informationClass, nint buffer, int length, out int returned);
    [DllImport("userenv.dll", EntryPoint = "DeriveAppContainerSidFromAppContainerName", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSid(string name, out nint sid);
    [DllImport("advapi32.dll")]
    private static extern nint FreeSid(nint sid);
}
