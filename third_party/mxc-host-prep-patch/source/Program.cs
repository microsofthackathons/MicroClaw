// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Adapted for MicroClaw from microsoft/mxc PR #649 at 695c2b89.

namespace MicroClaw.MxcHostPrep;

internal static class Program
{
    private const string PrepareCommand = "prepare-system-drive";
    private const string UnprepareCommand = "unprepare-system-drive";

    public static int Main(string[] args)
    {
        try
        {
            var (command, target) = ParseArguments(args);
            var root = SystemDrivePreparation.ResolveAndValidateTarget(target);
            Console.WriteLine(
                $"{(command == PrepareCommand ? "Adding" : "Removing")} metadata-read ACEs on {root}");
            Console.WriteLine(
                $"  mask : 0x{SystemDrivePreparation.MetadataReadMask:X8} "
                    + "(FILE_READ_ATTRIBUTES | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE)");

            if (command == PrepareCommand)
            {
                SystemDrivePreparation.ApplyAll(root);
            }
            else
            {
                SystemDrivePreparation.RevokeAll(root);
            }

            Console.WriteLine("Done.");
            return 0;
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine($"error: {exception.Message}");
            PrintUsage();
            return 1;
        }
        catch (HostPreparationException exception)
        {
            Console.Error.WriteLine($"error: {exception.Message}");
            return exception.ExitCode;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"error: {exception.Message}");
            return 6;
        }
    }

    private static (string Command, string? Target) ParseArguments(string[] args)
    {
        if (args.Length is < 1 or > 3)
        {
            throw new ArgumentException("Expected one system-drive operation and an optional target.");
        }

        var command = args[0];
        if (command is not PrepareCommand and not UnprepareCommand)
        {
            throw new ArgumentException($"Unsupported operation: {command}");
        }

        if (args.Length == 1)
        {
            return (command, null);
        }

        if (args.Length != 3 || !string.Equals(args[1], "--target", StringComparison.Ordinal))
        {
            throw new ArgumentException("The only supported option is --target <drive-root>.");
        }

        return (command, args[2]);
    }

    private static void PrintUsage()
    {
        Console.Error.WriteLine(
            "usage: microclaw-mxc-host-prep.exe "
                + "<prepare-system-drive|unprepare-system-drive> [--target C:\\]");
    }
}
