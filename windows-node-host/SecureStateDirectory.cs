using System.Security.AccessControl;
using System.Security.Principal;

namespace MicroClaw.WindowsNodeHost;

internal static class SecureStateDirectory
{
    public static void Ensure(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new HostPolicyException("identity-path-missing", "The helper identity directory is missing.");
        Directory.CreateDirectory(path);

        var currentUser = WindowsIdentity.GetCurrent().User
            ?? throw new HostPolicyException("identity-acl-user", "The current Windows user SID is unavailable.");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(
            currentUser,
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        new DirectoryInfo(path).SetAccessControl(security);
    }
}
