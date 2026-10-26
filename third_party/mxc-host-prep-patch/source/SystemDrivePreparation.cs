// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Adapted for MicroClaw from microsoft/mxc PR #649 at 695c2b89.

using System.Security.AccessControl;
using System.Security.Principal;

namespace MicroClaw.MxcHostPrep;

internal class HostPreparationException(string message, int exitCode = 6)
    : Exception(message)
{
    public int ExitCode { get; } = exitCode;
}

internal sealed class ConflictingAceException(
    string path,
    SecurityIdentifier sid,
    ExplicitAce existing)
    : HostPreparationException(
        $"{path} already has an explicit {existing.Qualifier} ACE for {sid.Value} with mask "
            + $"0x{existing.AccessMask:X8} and flags 0x{(byte)existing.Flags:X2}; expected an "
            + $"AccessAllowed ACE with mask 0x{SystemDrivePreparation.MetadataReadMask:X8} "
            + "and flags 0x00. Refusing to merge or overwrite the existing ACE.",
        1);

internal static class SystemDrivePreparation
{
    internal const int MetadataReadMask = 0x0012_0088;

    private static readonly (string Name, SecurityIdentifier Sid)[] Trustees =
    [
        (
            "ALL APPLICATION PACKAGES",
            new SecurityIdentifier("S-1-15-2-1")
        ),
        (
            "ALL RESTRICTED APPLICATION PACKAGES",
            new SecurityIdentifier("S-1-15-2-2")
        ),
    ];

    internal static string ResolveAndValidateTarget(string? explicitTarget)
    {
        var raw = explicitTarget ?? Environment.GetEnvironmentVariable("SystemDrive");
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new HostPreparationException(
                "Could not resolve %SystemDrive%; specify --target <drive-root>.",
                1);
        }

        var normalized =
            explicitTarget is null && raw.Length == 2 && raw[1] == ':' ? $"{raw}\\" : raw;
        if (
            normalized.Length != 3
            || !char.IsAsciiLetter(normalized[0])
            || normalized[1] != ':'
            || normalized[2] != '\\'
        )
        {
            throw new HostPreparationException(
                $"Target must be a literal local drive root such as C:\\; got {raw}.",
                1);
        }

        var fullPath = Path.GetFullPath(normalized);
        if (!Directory.Exists(fullPath))
        {
            throw new HostPreparationException($"Target drive root does not exist: {fullPath}", 1);
        }

        return fullPath;
    }

    internal static void ApplyAll(string path)
    {
        var existingByTrustee = new List<(string Name, SecurityIdentifier Sid, int MatchCount)>();
        foreach (var (name, sid) in Trustees)
        {
            var prior = TargetOnlyDacl.ScanExplicitBasicAces(path, sid);
            foreach (var existing in prior)
            {
                if (
                    existing.AccessMask != MetadataReadMask
                    || existing.Qualifier != AceQualifier.AccessAllowed
                    || existing.Flags != AceFlags.None
                )
                {
                    throw new ConflictingAceException(path, sid, existing);
                }
            }

            existingByTrustee.Add((name, sid, prior.Count));
        }

        // Preflight every trustee before the first write so a conflict on the
        // second SID cannot leave the drive root partially prepared.
        foreach (var (name, sid, matchCount) in existingByTrustee)
        {
            Console.WriteLine($"  + {name,-45} ({sid.Value})");
            if (matchCount == 0)
            {
                TargetOnlyDacl.AddExplicitBasicAce(
                    path,
                    sid,
                    MetadataReadMask,
                    AceQualifier.AccessAllowed,
                    AceFlags.None);
            }
        }
    }

    internal static void RevokeAll(string path)
    {
        foreach (var (name, sid) in Trustees)
        {
            var removed = TargetOnlyDacl.RemoveExactExplicitBasicAces(
                path,
                sid,
                MetadataReadMask,
                AceQualifier.AccessAllowed,
                AceFlags.None);
            Console.WriteLine(
                removed > 0
                    ? $"  - {name,-45} ({sid.Value}) [{removed} ACE(s) removed]"
                    : $"  . {name,-45} ({sid.Value}) [no matching ACE; nothing to do]");
        }
    }
}
