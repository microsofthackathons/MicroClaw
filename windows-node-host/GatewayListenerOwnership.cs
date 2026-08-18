using System.Net;
using System.Runtime.InteropServices;

namespace MicroClaw.WindowsNodeHost;

public static class GatewayListenerOwnership
{
    private const int AddressFamilyInet = 2;
    private const uint ErrorInsufficientBuffer = 122;
    private const uint TcpStateListen = 2;
    private const int TcpTableOwnerPidListener = 3;

    public static bool IsLoopbackListenerOwnedBy(int port, int processId)
    {
        if (port is < 1 or > 65535 || processId <= 0)
            return false;

        uint bufferSize = 0;
        var status = GetExtendedTcpTable(
            IntPtr.Zero,
            ref bufferSize,
            true,
            AddressFamilyInet,
            TcpTableOwnerPidListener,
            0);
        if (status != ErrorInsufficientBuffer || bufferSize == 0)
            return false;

        var buffer = Marshal.AllocHGlobal(checked((int)bufferSize));
        try
        {
            status = GetExtendedTcpTable(
                buffer,
                ref bufferSize,
                true,
                AddressFamilyInet,
                TcpTableOwnerPidListener,
                0);
            if (status != 0)
                return false;

            var count = Marshal.ReadInt32(buffer);
            var rowPointer = IntPtr.Add(buffer, sizeof(uint));
            var rowSize = Marshal.SizeOf<TcpRowOwnerPid>();
            for (var index = 0; index < count; index++)
            {
                var row = Marshal.PtrToStructure<TcpRowOwnerPid>(
                    IntPtr.Add(rowPointer, checked(index * rowSize)));
                var networkPort = unchecked((short)(row.LocalPort & 0xffff));
                var listenerPort = unchecked((ushort)IPAddress.NetworkToHostOrder(networkPort));
                if (row.State == TcpStateListen
                    && listenerPort == port
                    && row.OwningProcessId == processId
                    && new IPAddress(row.LocalAddress).Equals(IPAddress.Loopback))
                    return true;
            }
            return false;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TcpRowOwnerPid
    {
        public uint State;
        public uint LocalAddress;
        public uint LocalPort;
        public uint RemoteAddress;
        public uint RemotePort;
        public int OwningProcessId;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr tcpTable,
        ref uint sizePointer,
        [MarshalAs(UnmanagedType.Bool)] bool order,
        int addressFamily,
        int tableClass,
        uint reserved);
}
