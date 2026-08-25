// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Adapted for MicroClaw from microsoft/mxc PR #649 at 695c2b89.

using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace MicroClaw.MxcHostPrep;

internal readonly record struct ExplicitAce(
    AceQualifier Qualifier,
    int AccessMask,
    AceFlags Flags);

internal static class TargetOnlyDacl
{
    private const uint DaclSecurityInformation = 0x0000_0004;

    [DllImport("advapi32.dll", EntryPoint = "SetFileSecurityW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileSecurity(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        uint securityInformation,
        byte[] securityDescriptor);

    internal static IReadOnlyList<ExplicitAce> ScanExplicitBasicAces(
        string path,
        SecurityIdentifier sid)
    {
        var dacl = ReadDacl(path);
        var matches = new List<ExplicitAce>();
        for (var index = 0; index < dacl.Count; index++)
        {
            if (
                dacl[index] is CommonAce ace
                && !ace.IsInherited
                && !ace.IsCallback
                && ace.SecurityIdentifier == sid
                && ace.AceQualifier is AceQualifier.AccessAllowed or AceQualifier.AccessDenied
            )
            {
                matches.Add(new ExplicitAce(ace.AceQualifier, ace.AccessMask, ace.AceFlags));
            }
        }

        return matches;
    }

    internal static void AddExplicitBasicAce(
        string path,
        SecurityIdentifier sid,
        int accessMask,
        AceQualifier qualifier,
        AceFlags flags,
        bool isCallback = false)
    {
        if (qualifier is not AceQualifier.AccessAllowed and not AceQualifier.AccessDenied)
        {
            throw new ArgumentOutOfRangeException(nameof(qualifier));
        }

        var dacl = ReadDacl(path);
        var insertionIndex = 0;
        if (qualifier == AceQualifier.AccessAllowed)
        {
            while (insertionIndex < dacl.Count && !dacl[insertionIndex].IsInherited)
            {
                insertionIndex++;
            }
        }

        dacl.InsertAce(
            insertionIndex,
            new CommonAce(flags, qualifier, accessMask, sid, isCallback, opaque: null));
        WriteDacl(path, dacl);
    }

    internal static int RemoveExactExplicitBasicAces(
        string path,
        SecurityIdentifier sid,
        int accessMask,
        AceQualifier qualifier,
        AceFlags flags)
    {
        var dacl = ReadDacl(path);
        var removed = 0;
        for (var index = dacl.Count - 1; index >= 0; index--)
        {
            if (
                dacl[index] is CommonAce ace
                && !ace.IsInherited
                && !ace.IsCallback
                && ace.SecurityIdentifier == sid
                && ace.AceQualifier == qualifier
                && ace.AccessMask == accessMask
                && ace.AceFlags == flags
            )
            {
                dacl.RemoveAce(index);
                removed++;
            }
        }

        if (removed > 0)
        {
            WriteDacl(path, dacl);
        }

        return removed;
    }

    internal static byte[] ReadDaclBytes(string path)
    {
        var dacl = ReadDacl(path);
        var bytes = new byte[dacl.BinaryLength];
        dacl.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static RawAcl ReadDacl(string path)
    {
        var security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access);
        var descriptorBytes = security.GetSecurityDescriptorBinaryForm();
        var descriptor = new RawSecurityDescriptor(descriptorBytes, 0);
        return descriptor.DiscretionaryAcl
            ?? throw new HostPreparationException(
                $"Refusing to modify {path} because it has a null DACL.");
    }

    private static void WriteDacl(string path, RawAcl dacl)
    {
        var descriptor = new RawSecurityDescriptor(
            ControlFlags.DiscretionaryAclPresent | ControlFlags.SelfRelative,
            owner: null,
            group: null,
            systemAcl: null,
            discretionaryAcl: dacl);
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        if (!SetFileSecurity(path, DaclSecurityInformation, bytes))
        {
            throw new HostPreparationException(
                $"SetFileSecurityW failed for {path}: {new Win32Exception(Marshal.GetLastWin32Error()).Message}");
        }
    }
}
