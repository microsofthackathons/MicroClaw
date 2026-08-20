using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace MicroClaw.WindowsNodeHost;

internal sealed class ProcessTreeJob
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;

    private readonly SafeFileHandle handle;

    private ProcessTreeJob(SafeFileHandle handle)
    {
        this.handle = handle;
    }

    public static ProcessTreeJob CreateForCurrentProcess()
    {
        var handle = CreateJobObjectW(nint.Zero, null);
        if (handle.IsInvalid)
            throw CreateError("job-create-failed", "Windows could not create the MXC process-tree job.");

        try
        {
            var information = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation
                {
                    LimitFlags = JobObjectLimitKillOnJobClose,
                },
            };
            var size = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, buffer, false);
                if (!SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformationClass,
                        buffer,
                        (uint)size))
                    throw CreateError(
                        "job-limit-failed",
                        "Windows could not enable kill-on-close for the MXC process-tree job.");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            if (!AssignProcessToJobObject(handle, GetCurrentProcess()))
                throw CreateError(
                    "job-assign-failed",
                    "Windows could not bind the bundled node to its MXC process-tree job.");

            return new ProcessTreeJob(handle);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static HostPolicyException CreateError(string code, string message) =>
        new(code, $"{message} {new Win32Exception(Marshal.GetLastWin32Error()).Message}");

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(nint jobAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job,
        int informationClass,
        nint information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, nint process);

    [DllImport("kernel32.dll")]
    private static extern nint GetCurrentProcess();

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize;
        public nuint MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public nuint ProcessMemoryLimit;
        public nuint JobMemoryLimit;
        public nuint PeakProcessMemoryUsed;
        public nuint PeakJobMemoryUsed;
    }
}
