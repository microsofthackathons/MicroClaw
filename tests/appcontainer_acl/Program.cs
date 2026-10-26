using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using AppContainerLauncher;

var containerSid = new SecurityIdentifier("S-1-15-2-999-998-997-996-995-994-993");
var userSid = WindowsIdentity.GetCurrent().User ?? throw new Exception("Current user SID unavailable");
int assertions = 0;
void Check(bool condition, string description)
{
    assertions++;
    if (!condition) throw new Exception(description);
}

DirectorySecurity DirectoryRules()
{
    var security = new DirectorySecurity();
    security.AddAccessRule(new FileSystemAccessRule(userSid, FileSystemRights.FullControl,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
        PropagationFlags.None, AccessControlType.Allow));
    return security;
}

var directory = DirectoryRules();
Check(ContainerManager.UpdateGrantRules(directory, containerSid, readOnly: false, isDirectory: true), "First RW grant must change ACL");
string granted = directory.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
Check(!ContainerManager.UpdateGrantRules(directory, containerSid, readOnly: false, isDirectory: true), "Repeated RW grant must not rewrite ACL");
Check(granted == directory.GetSecurityDescriptorSddlForm(AccessControlSections.Access), "Repeated grant must preserve the exact DACL");
Check(ContainerManager.UpdateGrantRules(directory, containerSid, readOnly: true, isDirectory: true), "Downgrade to RO must update ACL");
Check(!ContainerManager.UpdateGrantRules(directory, containerSid, readOnly: true, isDirectory: true), "Repeated RO grant must not rewrite ACL");
var readonlyRules = directory.GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
    .Where(rule => rule.IdentityReference == containerSid).ToArray();
Check(readonlyRules.Length == 1 && (readonlyRules[0].FileSystemRights & FileSystemRights.WriteData) == 0, "RO downgrade must remove write access");
Check(ContainerManager.UpdateGrantRules(directory, containerSid, readOnly: false, isDirectory: true), "Upgrade back to RW must update ACL");

var file = new FileSecurity();
file.AddAccessRule(new FileSystemAccessRule(userSid, FileSystemRights.FullControl, AccessControlType.Allow));
Check(ContainerManager.UpdateGrantRules(file, containerSid, readOnly: true, isDirectory: false), "First file grant must change ACL");
Check(!ContainerManager.UpdateGrantRules(file, containerSid, readOnly: true, isDirectory: false), "Repeated file grant must not rewrite ACL");
Check(ContainerManager.UpdateGrantRules(file, containerSid, readOnly: false, isDirectory: false), "File permission changes must still apply");

Check(ContainerManager.UpdateShieldRules(directory, containerSid), "Shield must remove the grant and protect inheritance");
Check(directory.AreAccessRulesProtected, "Shield must protect inherited access");
Check(!directory.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
    .Any(rule => rule.IdentityReference == containerSid), "Shield must remove container access");
Check(directory.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
    .Any(rule => rule.IdentityReference == userSid), "Shield must preserve the user's access");
Check(!ContainerManager.UpdateShieldRules(directory, containerSid), "Repeated shield must not rewrite ACL");
directory.SetAccessRuleProtection(isProtected: false, preserveInheritance: true);
Check(ContainerManager.UpdateShieldRules(directory, containerSid), "Removing protection must be detected without a cached marker");
ContainerManager.UpdateGrantRules(directory, containerSid, readOnly: false, isDirectory: true);
Check(ContainerManager.UpdateShieldRules(directory, containerSid), "A newly added grant must be removed again");

var workspace = args.Single();
Directory.CreateDirectory(workspace);
var info = new DirectoryInfo(workspace);
var actual = info.GetAccessControl();
Check(ContainerManager.UpdateGrantRules(actual, containerSid, readOnly: true, isDirectory: true), "Fresh disk ACL must require a grant");
info.SetAccessControl(actual);
var restored = info.GetAccessControl();
Check(!ContainerManager.UpdateGrantRules(restored, containerSid, readOnly: true, isDirectory: true), "A re-read disk ACL must remain idempotent");
Check(ContainerManager.UpdateShieldRules(restored, containerSid), "Disk shield must be required after a grant");
info.SetAccessControl(restored);
Check(!ContainerManager.UpdateShieldRules(info.GetAccessControl(), containerSid), "A re-read disk shield must remain idempotent");

var stopwatch = Stopwatch.StartNew();
int writes = 0;
for (int iteration = 0; iteration < 1000; iteration++)
{
    if (ContainerManager.UpdateShieldRules(restored, containerSid)) writes++;
}
Check(writes == 0, "Repeated startup checks must require zero ACL writes");
Console.WriteLine($"Passed {assertions} ACL assertions; 1000 unchanged checks: {stopwatch.ElapsedMilliseconds}ms, ACL writes: {writes}");
