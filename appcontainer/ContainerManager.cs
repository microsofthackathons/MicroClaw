using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using static AppContainerLauncher.NativeMethods;

namespace AppContainerLauncher;

/// <summary>
/// Manages AppContainer profiles, directory ACLs, and sandboxed process creation.
/// </summary>
internal static class ContainerManager
{
    // Well-known capability SIDs (S-1-15-3-1 through S-1-15-3-12)
    private static readonly Dictionary<string, string> CapabilitySids = new(StringComparer.OrdinalIgnoreCase)
    {
        ["internetClient"]              = "S-1-15-3-1",
        ["internetClientServer"]        = "S-1-15-3-2",
        ["privateNetworkClientServer"]  = "S-1-15-3-3",
        ["picturesLibrary"]             = "S-1-15-3-4",
        ["videosLibrary"]               = "S-1-15-3-5",
        ["musicLibrary"]                = "S-1-15-3-6",
        ["documentsLibrary"]            = "S-1-15-3-7",
        ["enterpriseAuthentication"]    = "S-1-15-3-8",
        ["sharedUserCertificates"]      = "S-1-15-3-9",
        ["removableStorage"]            = "S-1-15-3-10",
        ["appointments"]                = "S-1-15-3-11",
        ["contacts"]                    = "S-1-15-3-12",
    };

    // ── Environment sanitisation ───────────────────────────────────────────
    //
    // The launcher inherits the gateway's environment, which contains secrets
    // that must NOT cross the AppContainer trust boundary:
    //   * OPENCLAW_SANDBOX_HMAC_KEY  - signs the external-apps whitelist file;
    //                                  if leaked, an attacker inside AC can
    //                                  forge a whitelist that bypasses the
    //                                  sandbox entirely.
    //   * OPENCLAW_AC_EXTERNAL_APPS  - whitelist itself; sandboxed code has
    //                                  no business reading it.
    //   * MODEL_API_KEY / BRAVE_API_KEY / *_TOKEN / *_SECRET - third-party
    //                                  credentials that prompt-injection can
    //                                  exfiltrate from inside AC.
    //
    // CreateProcessW(lpEnvironment = NULL) inherits the parent block, so we
    // must build an explicit, filtered Unicode env block and pass it with
    // CREATE_UNICODE_ENVIRONMENT.
    //
    // Strategy: deny-list (block known-sensitive names + prefixes/suffixes),
    // allow everything else through so PATH / USERPROFILE / SystemRoot / TEMP
    // continue to work for legitimate AC children.

    private static readonly HashSet<string> SensitiveEnvNames = new(StringComparer.OrdinalIgnoreCase)
    {
        // NODE_OPTIONS would re-load sandbox-preload.js inside AC, which is
        // pointless (AC is the sandbox) and exposes preload internals.
        "NODE_OPTIONS",
        "BRAVE_API_KEY",
    };

    // Any variable whose NAME starts with these prefixes is dropped.
    // OPENCLAW_*  - all gateway internals (HMAC key, tokens, AC config, dirs)
    // MODEL_*     - MODEL_API_KEY, MODEL_BASE_URL, MODEL_NAME, ...
    private static readonly string[] SensitiveEnvPrefixes = new[]
    {
        "OPENCLAW_",
        "MODEL_",
    };

    // Any variable whose NAME ends with these suffixes is dropped.
    private static readonly string[] SensitiveEnvSuffixes = new[]
    {
        "_API_KEY", "_APIKEY", "_SECRET", "_TOKEN", "_PASSWORD", "_PASSWD",
    };

    internal static bool IsSensitiveEnvVar(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        if (SensitiveEnvNames.Contains(name)) return true;
        foreach (var p in SensitiveEnvPrefixes)
            if (name.StartsWith(p, StringComparison.OrdinalIgnoreCase)) return true;
        foreach (var s in SensitiveEnvSuffixes)
            if (name.EndsWith(s, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    /// <summary>
    /// Build a CREATE_UNICODE_ENVIRONMENT block from the launcher's own
    /// environment with sensitive variables stripped. Caller MUST free the
    /// returned pointer with Marshal.FreeHGlobal.
    /// </summary>
    private static IntPtr BuildSanitizedEnvBlock(out List<string> strippedNames)
    {
        strippedNames = new List<string>();
        var entries = new List<string>();
        foreach (System.Collections.DictionaryEntry kv in Environment.GetEnvironmentVariables())
        {
            var name = (string)kv.Key;
            var value = (string?)kv.Value ?? string.Empty;
            if (IsSensitiveEnvVar(name)) { strippedNames.Add(name); continue; }
            entries.Add(name + "=" + value);
        }
        // CreateProcessW expects the Unicode block sorted alphabetically.
        entries.Sort(StringComparer.OrdinalIgnoreCase);

        var sb = new StringBuilder();
        foreach (var e in entries) sb.Append(e).Append('\0');
        sb.Append('\0'); // final double-null terminator

        byte[] bytes = Encoding.Unicode.GetBytes(sb.ToString());
        IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, ptr, bytes.Length);
        return ptr;
    }

    // ── Profile Management ─────────────────────────────────────────────────

    /// <summary>
    /// Create an AppContainer profile (idempotent — returns existing SID if already created).
    /// Returns the SID as a string (e.g. "S-1-15-2-...").
    /// </summary>
    public static string EnsureProfile(string name)
    {
        IntPtr sidPtr;
        int hr = CreateAppContainerProfile(
            name,
            $"{name} Container",
            $"AppContainer sandbox for {name}",
            IntPtr.Zero, 0,
            out sidPtr);

        if (hr == E_ALREADY_EXISTS)
        {
            // Profile exists — derive the SID
            hr = DeriveAppContainerSidFromAppContainerName(name, out sidPtr);
            if (hr != 0)
                throw new COMException($"DeriveAppContainerSidFromAppContainerName failed: 0x{hr:X8}", hr);
        }
        else if (hr != 0)
        {
            throw new COMException($"CreateAppContainerProfile failed: 0x{hr:X8}", hr);
        }

        try
        {
            return SidPtrToString(sidPtr);
        }
        finally
        {
            FreeSid(sidPtr);
        }
    }

    /// <summary>
    /// Get the SID string for an existing profile (creates if needed).
    /// </summary>
    public static string GetSid(string name)
    {
        return EnsureProfile(name);
    }

    /// <summary>Delete an AppContainer profile.</summary>
    public static void DeleteProfile(string name)
    {
        int hr = NativeMethods.DeleteAppContainerProfile(name);
        // Ignore "not found" errors
        if (hr != 0 && hr != unchecked((int)0x80070002))
            throw new COMException($"DeleteAppContainerProfile failed: 0x{hr:X8}", hr);
    }

    // ── ACL Management ─────────────────────────────────────────────────────

    // Well-known SID for ALL APPLICATION PACKAGES (S-1-15-2-1).
    // Directories with this SID in their ACL are already accessible to any
    // AppContainer — no per-profile ACL grant is needed.
    private static readonly SecurityIdentifier AllAppPackagesSid =
        new SecurityIdentifier("S-1-15-2-1");

    /// <summary>
    /// Detect whether a DirectorySecurity object has a NULL or empty DACL.
    /// A NULL DACL means "everyone has full access" (including AppContainer),
    /// so writing back a DACL containing only our AppContainer ACE would
    /// *replace* that implicit full-access with a single-entry DACL and wipe
    /// all other principals (Administrators, Users, SYSTEM, …).
    /// </summary>
    private static bool IsNullOrEmptyDacl(CommonObjectSecurity security)
    {
        var sddl = security.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        // A NULL DACL produces no "D:" section at all, or "D:" with no ACEs.
        // An empty string after "D:" (e.g. "D:") also means zero ACEs.
        int dIdx = sddl.IndexOf("D:", StringComparison.Ordinal);
        if (dIdx < 0) return true;            // no DACL section → NULL DACL
        // Check whether there is at least one ACE "(…)" after the "D:…" flags
        int aceStart = sddl.IndexOf('(', dIdx);
        return aceStart < 0;                  // no ACE entries → empty DACL
    }

    /// <summary>
    /// Check whether a path already has sufficient access for ALL APPLICATION PACKAGES.
    /// If so, no per-profile ACL grant is needed (just add to settings).
    /// </summary>
    private static bool HasAllAppPackagesAccess(string path, bool readOnly)
    {
        try
        {
            AuthorizationRuleCollection rules;
            if (Directory.Exists(path))
            {
                rules = new DirectoryInfo(path).GetAccessControl()
                    .GetAccessRules(true, true, typeof(SecurityIdentifier));
            }
            else if (File.Exists(path))
            {
                rules = new FileInfo(path).GetAccessControl()
                    .GetAccessRules(true, true, typeof(SecurityIdentifier));
            }
            else return false;

            var needed = readOnly
                ? FileSystemRights.ReadAndExecute
                : FileSystemRights.Modify;

            foreach (FileSystemAccessRule rule in rules)
            {
                if (rule.IdentityReference.Value == AllAppPackagesSid.Value &&
                    rule.AccessControlType == AccessControlType.Allow &&
                    (rule.FileSystemRights & needed) == needed)
                {
                    return true;
                }
            }
        }
        catch { /* can't read ACL — assume no access */ }
        return false;
    }

    /// <summary>
    /// Grant the AppContainer access to a directory.
    /// Skips ACL modification if ALL APPLICATION PACKAGES already has sufficient access.
    /// Also grants traverse on ancestor directories so the AppContainer process
    /// can reach the target path (e.g. D:\ when granting D:\Documents).
    /// </summary>
    /// <param name="containerName">AppContainer profile name</param>
    /// <param name="dirPath">Directory to grant access to</param>
    /// <param name="readOnly">true = ReadAndExecute, false = FullControl</param>
    public static void GrantAccess(string containerName, string dirPath, bool readOnly)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        // Fast path: if ALL APPLICATION PACKAGES already has sufficient access,
        // skip per-profile ACL grant (the directory is accessible to any AppContainer).
        if (HasAllAppPackagesAccess(dirPath, readOnly))
        {
            Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] Skipped — ALL APPLICATION PACKAGES already has access: {dirPath}");
            return;
        }

        string sidStr = EnsureProfile(containerName);
        Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] SID resolved: {sidStr}");
        var sid = new SecurityIdentifier(sidStr);

        var rights = readOnly
            ? FileSystemRights.ReadAndExecute | FileSystemRights.ListDirectory
            : FileSystemRights.Modify | FileSystemRights.ListDirectory;

        if (Directory.Exists(dirPath))
        {
            var info = new DirectoryInfo(dirPath);
            var security = info.GetAccessControl();

            // Safety: a NULL/empty DACL means everyone already has full access
            // (including AppContainer). Writing back would replace it with a
            // single-entry DACL and strip Administrators/Users/SYSTEM.
            if (IsNullOrEmptyDacl(security))
            {
                Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] SKIPPED — NULL/empty DACL on dir (all access already implied): {dirPath}");
                return;
            }

            // Remove existing rules for this SID first (avoid duplicates)
            security.PurgeAccessRules(sid);

            security.AddAccessRule(new FileSystemAccessRule(
                sid,
                rights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));

            info.SetAccessControl(security);
            Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] SetAccessControl done for dir: {dirPath} (readOnly={readOnly})");
        }
        else if (File.Exists(dirPath))
        {
            var info = new FileInfo(dirPath);
            var security = info.GetAccessControl();

            if (IsNullOrEmptyDacl(security))
            {
                Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] SKIPPED — NULL/empty DACL on file (all access already implied): {dirPath}");
                return;
            }

            security.PurgeAccessRules(sid);
            security.AddAccessRule(new FileSystemAccessRule(
                sid, rights,
                InheritanceFlags.None,
                PropagationFlags.None,
                AccessControlType.Allow));
            info.SetAccessControl(security);
            Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] SetAccessControl done for file: {dirPath} (readOnly={readOnly})");
        }
        else
        {
            throw new DirectoryNotFoundException($"Path not found: {dirPath}");
        }

        // Grant traverse on ancestor directories so the AC process can reach
        // this path. Failures are non-fatal (e.g. drive root may need admin).
        try
        {
            GrantAncestorTraverse(containerName, dirPath);
            Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] GrantAncestorTraverse done for: {dirPath}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] WARNING: GrantAncestorTraverse FAILED for {dirPath}: {ex.Message}");
        }

        Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] GrantAccess complete for: {dirPath} (readOnly={readOnly})");

        // NOTE: GrantProtectedChildren is NOT called here — it's invoked
        // explicitly by Electron main.ts only for user-initiated grants.
        // If called during startup provisioning, it would re-create ACLs
        // on child directories that the user may have intentionally removed.
    }

    /// <summary>
    /// Revoke the AppContainer's access to a directory.
    /// If the ACL on this directory is inherited from a parent, walks up the
    /// directory tree to find and revoke the source of the inherited ACL.
    /// </summary>
    public static void RevokeAccess(string containerName, string dirPath)
    {
        string sidStr = EnsureProfile(containerName);
        var sid = new SecurityIdentifier(sidStr);

        if (Directory.Exists(dirPath))
        {
            var info = new DirectoryInfo(dirPath);
            var security = info.GetAccessControl();

            // Check if ACL is inherited — if so, find and revoke at source
            bool hasExplicit = false;
            bool hasInherited = false;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.IdentityReference.Value == sidStr && rule.AccessControlType == AccessControlType.Allow)
                {
                    if (rule.IsInherited) hasInherited = true;
                    else hasExplicit = true;
                }
            }

            // Remove explicit rules on this directory
            if (hasExplicit)
            {
                security.PurgeAccessRules(sid);
                info.SetAccessControl(security);
            }

            // Revoke ACL from immediate child directories that have inheritance
            // protection (matching GrantProtectedChildren). These children received
            // explicit ACLs during grant because inheritance was blocked.
            try { RevokeProtectedChildren(containerName, dirPath); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[revoke] Warning: protected children for {dirPath}: {ex.Message}");
            }

            // If inherited ACL exists, walk up to find the source and revoke there.
            // IMPORTANT: Only remove traverse ACEs, not all rules — other sibling
            // directories may still need traverse access on the same ancestor.
            if (hasInherited)
            {
                string? parent = Path.GetDirectoryName(Path.GetFullPath(dirPath));
                while (parent != null)
                {
                    try
                    {
                        var parentInfo = new DirectoryInfo(parent);
                        var parentSecurity = parentInfo.GetAccessControl();
                        var parentRules = parentSecurity.GetAccessRules(true, false, typeof(SecurityIdentifier));
                        bool modified = false;
                        foreach (FileSystemAccessRule rule in parentRules)
                        {
                            if (rule.IdentityReference.Value == sidStr && rule.AccessControlType == AccessControlType.Allow)
                            {
                                // Only remove traverse-only ACEs (not full access grants)
                                var traverseOnly = FileSystemRights.ReadAttributes |
                                    FileSystemRights.ReadExtendedAttributes | FileSystemRights.Traverse;
                                if ((rule.FileSystemRights & ~traverseOnly) == 0)
                                {
                                    parentSecurity.RemoveAccessRule(rule);
                                    modified = true;
                                    Console.Error.WriteLine($"[revoke] Removed traverse ACE from ancestor: {parent}");
                                }
                                else
                                {
                                    // This ancestor has a broader grant (e.g. another
                                    // dir at this level) — do NOT remove it.
                                    Console.Error.WriteLine($"[revoke] Skipped non-traverse ACE on ancestor: {parent} ({rule.FileSystemRights})");
                                }
                            }
                        }
                        if (modified) parentInfo.SetAccessControl(parentSecurity);
                        // Stop walking up once we found and handled the source
                        if (modified) break;
                    }
                    catch (UnauthorizedAccessException)
                    {
                        Console.Error.WriteLine($"[revoke] Cannot revoke inherited ACL at {parent} (need admin)");
                        break;
                    }
                    catch { break; }
                    parent = Path.GetDirectoryName(parent);
                }
            }
        }
        else if (File.Exists(dirPath))
        {
            var info = new FileInfo(dirPath);
            var security = info.GetAccessControl();
            security.PurgeAccessRules(sid);
            info.SetAccessControl(security);
        }
        // No error if path doesn't exist — may have been deleted
    }

    // ── ACL Verification ───────────────────────────────────────────────────

    /// <summary>
    /// Check whether the AppContainer profile has access to a directory.
    /// Returns JSON with access details.
    /// </summary>
    public static string CheckAccess(string containerName, string dirPath, bool readOnly)
    {
        if (!Directory.Exists(dirPath) && !File.Exists(dirPath))
        {
            return $"{{\"path\":{JsonEscape(dirPath)},\"exists\":false}}";
        }

        string sidStr = EnsureProfile(containerName);
        bool hasProfileAccess = false;
        string profileRights = "";
        bool hasAllAppPkg = false;
        string allAppRights = "";

        try
        {
            AuthorizationRuleCollection rules;
            if (Directory.Exists(dirPath))
                rules = new DirectoryInfo(dirPath).GetAccessControl()
                    .GetAccessRules(true, true, typeof(SecurityIdentifier));
            else
                rules = new FileInfo(dirPath).GetAccessControl()
                    .GetAccessRules(true, true, typeof(SecurityIdentifier));

            var needed = readOnly
                ? FileSystemRights.ReadAndExecute
                : FileSystemRights.Modify;

            foreach (FileSystemAccessRule rule in rules)
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;

                if (rule.IdentityReference.Value == sidStr)
                {
                    hasProfileAccess = true;
                    profileRights = rule.FileSystemRights.ToString();
                }
                else if (rule.IdentityReference.Value == AllAppPackagesSid.Value)
                {
                    hasAllAppPkg = true;
                    allAppRights = rule.FileSystemRights.ToString();
                }
            }

            bool sufficient = hasProfileAccess &&
                (new SecurityIdentifier(sidStr) is var sid2) &&
                rules.Cast<FileSystemAccessRule>().Any(r =>
                    r.IdentityReference.Value == sidStr &&
                    r.AccessControlType == AccessControlType.Allow &&
                    (r.FileSystemRights & needed) == needed);

            // Also count as sufficient if ALL APPLICATION PACKAGES has it
            if (!sufficient && hasAllAppPkg)
            {
                sufficient = rules.Cast<FileSystemAccessRule>().Any(r =>
                    r.IdentityReference.Value == AllAppPackagesSid.Value &&
                    r.AccessControlType == AccessControlType.Allow &&
                    (r.FileSystemRights & needed) == needed);
            }

            return $"{{\"path\":{JsonEscape(dirPath)},\"exists\":true," +
                   $"\"hasProfileAccess\":{(hasProfileAccess ? "true" : "false")}," +
                   $"\"profileRights\":{JsonEscape(profileRights)}," +
                   $"\"hasAllAppPackages\":{(hasAllAppPkg ? "true" : "false")}," +
                   $"\"allAppRights\":{JsonEscape(allAppRights)}," +
                   $"\"sufficient\":{(sufficient ? "true" : "false")}}}";
        }
        catch (Exception ex)
        {
            return $"{{\"path\":{JsonEscape(dirPath)},\"exists\":true,\"error\":{JsonEscape(ex.Message)}}}";
        }
    }

    /// <summary>
    /// Scan directories (up to maxDepth levels) on all fixed drives for stale
    /// AppContainer ACLs — entries with the profile's SID that shouldn't be there.
    /// Returns one JSON line per found entry to stdout.
    /// </summary>
    public static void ScanStaleAcls(string containerName, ISet<string> knownDirs, int maxDepth = 2)
    {
        string sidStr = EnsureProfile(containerName);

        foreach (var drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
            ScanDir(drive.RootDirectory.FullName, sidStr, knownDirs, 0, maxDepth);
        }
    }

    private static void ScanDir(string dir, string sidStr, ISet<string> knownDirs, int depth, int maxDepth)
    {
        if (depth > maxDepth) return;

        // Skip if this directory is in the known set (expected to have ACL)
        string normalized = dir.TrimEnd('\\', '/').ToLowerInvariant();
        if (!knownDirs.Contains(normalized))
        {
            try
            {
                var info = new DirectoryInfo(dir);
                var security = info.GetAccessControl();
                var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier));

                foreach (FileSystemAccessRule rule in rules)
                {
                    if (rule.IdentityReference.Value == sidStr &&
                        rule.AccessControlType == AccessControlType.Allow)
                    {
                        Console.WriteLine($"{{\"path\":{JsonEscape(dir)}," +
                            $"\"rights\":{JsonEscape(rule.FileSystemRights.ToString())}," +
                            $"\"inherited\":{(rule.IsInherited ? "true" : "false")}}}");
                        break;
                    }
                }
            }
            catch { /* skip inaccessible dirs */ }
        }

        if (depth >= maxDepth) return;
        try
        {
            foreach (var sub in Directory.EnumerateDirectories(dir))
            {
                ScanDir(sub, sidStr, knownDirs, depth + 1, maxDepth);
            }
        }
        catch { /* skip inaccessible dirs */ }
    }

    private static string JsonEscape(string s)
    {
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    // ── Process Launch ─────────────────────────────────────────────────────

    /// <summary>
    /// Grant traverse (ReadAndExecute) access to all ancestor directories
    /// from the given path up to the drive root. This is required because
    /// Node.js realpathSync() walks up the directory tree and calls lstat()
    /// on each parent, which AppContainer blocks by default.
    /// </summary>
    public static void GrantAncestorTraverse(string containerName, string dirPath)
    {
        string sidStr = EnsureProfile(containerName);
        var sid = new SecurityIdentifier(sidStr);

        // Walk up from dirPath to the drive root
        string? current = Path.GetDirectoryName(Path.GetFullPath(dirPath));
        while (current != null)
        {
            try
            {
                var info = new DirectoryInfo(current);
                var security = info.GetAccessControl();

                // Check if the SID already has traverse access
                var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier));
                bool hasAccess = false;
                foreach (FileSystemAccessRule rule in rules)
                {
                    if (rule.IdentityReference.Value == sidStr &&
                        rule.AccessControlType == AccessControlType.Allow &&
                        (rule.FileSystemRights & FileSystemRights.Traverse) != 0)
                    {
                        hasAccess = true;
                        break;
                    }
                }

                if (!hasAccess)
                {
                    // Safety: skip if DACL is NULL/empty — all access is already
                    // implied and writing back would wipe other principals.
                    if (IsNullOrEmptyDacl(security))
                    {
                        Console.Error.WriteLine($"[traverse] SKIPPED — NULL/empty DACL (all access already implied): {current}");
                    }
                    else
                    {
                        // Traverse + ReadAttributes only (no ListDirectory to avoid exposing
                        // directory contents — e.g. D:\ sibling folder names are private).
                        security.AddAccessRule(new FileSystemAccessRule(
                            sid,
                            FileSystemRights.ReadAttributes |
                            FileSystemRights.ReadExtendedAttributes | FileSystemRights.Traverse,
                            InheritanceFlags.None,
                            PropagationFlags.None,
                            AccessControlType.Allow));
                        info.SetAccessControl(security);
                        Console.Error.WriteLine($"[traverse] Granted: {current}");
                    }
                }
                else
                {
                    Console.Error.WriteLine($"[traverse] Already has access: {current}");
                }
            }
            catch (UnauthorizedAccessException)
            {
                // Can't modify ACL for this directory (e.g. C:\) — skip
                Console.Error.WriteLine($"[traverse] BLOCKED (need admin): {current}");
                break;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[traverse] Error for {current}: {ex.Message}");
            }

            current = Path.GetDirectoryName(current);
        }
    }

    /// <summary>
    /// Grant ACL to immediate child directories that have inheritance protection enabled.
    /// Windows user profile directories (e.g. C:\Users\username) block ACL inheritance
    /// from the parent by default. When a user grants access to C:\Users, the AppContainer
    /// SID won't propagate to C:\Users\username unless we explicitly grant it.
    /// Only processes the first level of children to avoid expensive deep traversals.
    /// </summary>
    public static void GrantProtectedChildren(string containerName, string dirPath, bool readOnly)
    {
        string sidStr = EnsureProfile(containerName);
        var sid = new SecurityIdentifier(sidStr);

        var rights = readOnly
            ? FileSystemRights.ReadAndExecute | FileSystemRights.ListDirectory
            : FileSystemRights.Modify | FileSystemRights.ListDirectory;

        DirectoryInfo parent;
        try { parent = new DirectoryInfo(dirPath); }
        catch { return; }

        DirectoryInfo[] children;
        try { children = parent.GetDirectories(); }
        catch { return; }

        foreach (var child in children)
        {
            try
            {
                var childSecurity = child.GetAccessControl();
                if (!childSecurity.AreAccessRulesProtected)
                    continue; // inheritance enabled — parent ACL will propagate

                var rules = childSecurity.GetAccessRules(true, false, typeof(SecurityIdentifier));
                bool hasAccess = false;
                foreach (FileSystemAccessRule rule in rules)
                {
                    if (rule.IdentityReference.Value == sidStr &&
                        rule.AccessControlType == AccessControlType.Allow)
                    {
                        hasAccess = true;
                        break;
                    }
                }

                if (!hasAccess)
                {
                    childSecurity.PurgeAccessRules(sid);
                    childSecurity.AddAccessRule(new FileSystemAccessRule(
                        sid, rights,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                        PropagationFlags.None,
                        AccessControlType.Allow));
                    child.SetAccessControl(childSecurity);
                    Console.Error.WriteLine($"[grant] Granted protected child: {child.FullName}");
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"[grant] Cannot set ACL on protected child (need admin): {child.FullName}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[grant] Warning: protected child {child.FullName}: {ex.Message}");
            }
        }
    }

    /// <summary>
    /// Revoke ACL from immediate child directories that have inheritance protection.
    /// Counterpart to GrantProtectedChildren — removes the explicit ACLs that were
    /// added because inheritance was blocked on these children.
    /// </summary>
    public static void RevokeProtectedChildren(string containerName, string dirPath)
    {
        string sidStr = EnsureProfile(containerName);
        var sid = new SecurityIdentifier(sidStr);

        DirectoryInfo parent;
        try { parent = new DirectoryInfo(dirPath); }
        catch { return; }

        DirectoryInfo[] children;
        try { children = parent.GetDirectories(); }
        catch { return; }

        foreach (var child in children)
        {
            try
            {
                var childSecurity = child.GetAccessControl();
                if (!childSecurity.AreAccessRulesProtected)
                    continue;

                var rules = childSecurity.GetAccessRules(true, false, typeof(SecurityIdentifier));
                bool hasAccess = false;
                foreach (FileSystemAccessRule rule in rules)
                {
                    if (rule.IdentityReference.Value == sidStr &&
                        rule.AccessControlType == AccessControlType.Allow)
                    {
                        hasAccess = true;
                        break;
                    }
                }

                if (hasAccess)
                {
                    childSecurity.PurgeAccessRules(sid);
                    child.SetAccessControl(childSecurity);
                    Console.Error.WriteLine($"[revoke] Revoked protected child: {child.FullName}");
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"[revoke] Cannot revoke ACL on protected child (need admin): {child.FullName}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[revoke] Warning: protected child {child.FullName}: {ex.Message}");
            }
        }
    }

    // ── Sensitive Path Shield ───────────────────────────────────────────────

    /// <summary>Known-sensitive subdirectories whose ACLs must not inherit AppContainer SID.</summary>
    private static readonly string[] DefaultSensitiveDirs = {
        ".ssh", ".gnupg", ".aws", ".azure",
        Path.Combine(".config", "gcloud"),
    };

    /// <summary>
    /// Get the default list of sensitive directory names.
    /// Exposed for CLI and testing.
    /// </summary>
    public static string[] GetDefaultSensitiveDirs() => DefaultSensitiveDirs;

    /// <summary>
    /// Break ACL inheritance on sensitive subdirectories and remove the
    /// AppContainer SID, so that the sandbox process cannot access these
    /// files at all and external tools (OpenSSH, GPG) ACLs stay clean.
    ///
    /// This is a standalone operation — does NOT modify GrantAccess/RevokeAccess
    /// internals. The caller is responsible for orchestrating the call sequence.
    /// </summary>
    public static List<string> ShieldSensitivePaths(string containerName, string parentDir, string[]? extraDirs = null)
    {
        string sidStr = EnsureProfile(containerName);
        var sid = new SecurityIdentifier(sidStr);
        var shielded = new List<string>();
        var dirsToCheck = DefaultSensitiveDirs.AsEnumerable();
        if (extraDirs != null) dirsToCheck = dirsToCheck.Concat(extraDirs);

        foreach (var rel in dirsToCheck)
        {
            var fullPath = Path.Combine(parentDir, rel);
            if (!Directory.Exists(fullPath)) continue;

            try
            {
                var info = new DirectoryInfo(fullPath);
                var security = info.GetAccessControl();

                // Step 1: Break inheritance, copy existing inherited ACEs as explicit
                security.SetAccessRuleProtection(isProtected: true, preserveInheritance: true);

                // Step 2: Remove all explicit rules for this Container SID
                security.PurgeAccessRules(sid);

                info.SetAccessControl(security);
                shielded.Add(fullPath);
                Console.Error.WriteLine($"[shield] Shielded sensitive dir: {fullPath}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[shield] Warning: failed to shield {fullPath}: {ex.Message}");
            }
        }
        return shielded;
    }

    /// <summary>
    /// Restore ACL inheritance on a previously-shielded directory.
    /// Standalone operation — call before RevokeAccess to clean up.
    /// </summary>
    public static void UnshieldPath(string dirPath)
    {
        if (!Directory.Exists(dirPath)) return;
        var info = new DirectoryInfo(dirPath);
        var security = info.GetAccessControl();
        // Re-enable inheritance, remove explicit copies of inherited rules
        security.SetAccessRuleProtection(isProtected: false, preserveInheritance: false);
        info.SetAccessControl(security);
        Console.Error.WriteLine($"[shield] Unshielded: {dirPath}");
    }

    // ── Process Launch ─────────────────────────────────────────────────────

    /// <summary>
    /// Run a process inside the AppContainer sandbox.
    /// Blocks until the child process exits. Returns the exit code.
    /// </summary>
    /// <param name="containerName">AppContainer profile name</param>
    /// <param name="exePath">Path to the executable</param>
    /// <param name="childArgs">Arguments for the child process</param>
    /// <param name="workDir">Working directory (null = inherit)</param>
    /// <param name="capabilities">Capability names (e.g. "internetClient")</param>
    /// <param name="noWindow">Suppress console window creation</param>
    public static int Run(
        string containerName,
        string exePath,
        string[] childArgs,
        string? workDir,
        string[] capabilities,
        bool noWindow,
        bool quiet = false,
        bool skipSetup = false)
    {
        // In quiet mode, redirect stderr to suppress all diagnostic output
        // from sub-methods (GrantAncestorTraverse, SetLoopbackExemption, etc.)
        TextWriter? savedStderr = null;
        if (quiet)
        {
            savedStderr = Console.Error;
            Console.SetError(TextWriter.Null);
        }

        if (!skipSetup)
        {
            // 0. Auto-grant traverse to ancestor directories (for realpathSync)
            try
            {
                if (workDir != null) GrantAncestorTraverse(containerName, workDir);
                GrantAncestorTraverse(containerName, exePath);
            }
            catch (Exception ex)
            {
                if (!quiet) Console.Error.WriteLine($"[AppContainerLauncher] Warning: ancestor traverse setup: {ex.Message}");
            }

            // 0b. Ensure loopback exemption is set (required for inbound connections)
            try { SetLoopbackExemption(containerName, true); }
            catch (Exception ex)
            {
                if (!quiet) Console.Error.WriteLine($"[AppContainerLauncher] Warning: loopback exemption: {ex.Message}");
            }

            // 0c. Clean stale gateway lock files from system TEMP
            //     AppContainer can read these but process.kill(pid,0) returns EPERM
            //     instead of ESRCH, causing the gateway to think stale processes live.
            try { CleanStaleLockFiles(); }
            catch { /* best effort */ }
        }

        // 1. Get or create profile
        IntPtr containerSidPtr;
        int hr = CreateAppContainerProfile(
            containerName,
            $"{containerName} Container",
            $"AppContainer sandbox for {containerName}",
            IntPtr.Zero, 0,
            out containerSidPtr);

        if (hr == E_ALREADY_EXISTS)
        {
            hr = DeriveAppContainerSidFromAppContainerName(containerName, out containerSidPtr);
            if (hr != 0)
                throw new COMException($"DeriveAppContainerSidFromAppContainerName failed: 0x{hr:X8}", hr);
        }
        else if (hr != 0)
        {
            throw new COMException($"CreateAppContainerProfile failed: 0x{hr:X8}", hr);
        }

        // We need to keep all native allocations alive until after CreateProcess
        var allocations = new List<IntPtr>();
        try
        {
            // 2. Build capability SID array
            IntPtr capArrayPtr = IntPtr.Zero;
            int capCount = 0;

            if (capabilities.Length > 0)
            {
                int entrySize = Marshal.SizeOf<SID_AND_ATTRIBUTES>();
                capArrayPtr = Marshal.AllocHGlobal(entrySize * capabilities.Length);
                allocations.Add(capArrayPtr);

                for (int i = 0; i < capabilities.Length; i++)
                {
                    string capName = capabilities[i];
                    if (!CapabilitySids.TryGetValue(capName, out string? capSidStr))
                        throw new ArgumentException($"Unknown capability: {capName}");

                    if (!ConvertStringSidToSidW(capSidStr, out IntPtr capSidPtr))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    allocations.Add(capSidPtr);

                    var entry = new SID_AND_ATTRIBUTES
                    {
                        Sid = capSidPtr,
                        Attributes = SE_GROUP_ENABLED,
                    };
                    Marshal.StructureToPtr(entry, capArrayPtr + i * entrySize, false);
                }
                capCount = capabilities.Length;
            }

            // 3. Build SECURITY_CAPABILITIES
            var secCaps = new SECURITY_CAPABILITIES
            {
                AppContainerSid = containerSidPtr,
                Capabilities = capArrayPtr,
                CapabilityCount = capCount,
                Reserved = 0,
            };
            IntPtr pSecCaps = Marshal.AllocHGlobal(Marshal.SizeOf<SECURITY_CAPABILITIES>());
            Marshal.StructureToPtr(secCaps, pSecCaps, false);
            allocations.Add(pSecCaps);

            // 4. Initialize process thread attribute list
            IntPtr attrListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrListSize);

            IntPtr attrList = Marshal.AllocHGlobal(attrListSize);
            allocations.Add(attrList);

            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrListSize))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            // 5. Set security capabilities attribute
            if (!UpdateProcThreadAttribute(
                attrList, 0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                pSecCaps,
                (IntPtr)Marshal.SizeOf<SECURITY_CAPABILITIES>(),
                IntPtr.Zero, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            // 6. Build STARTUPINFOEX with stdio handles
            //    Use an anonymous pipe for stdout so it works under
            //    CREATE_NO_WINDOW + AppContainer (console handles are not
            //    writable by the sandboxed child; pipe handles are).
            var pipeSa = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(),
                lpSecurityDescriptor = IntPtr.Zero,
                bInheritHandle = true,
            };
            if (!CreatePipe(out IntPtr stdoutRead, out IntPtr stdoutWrite, ref pipeSa, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe for stdout failed");
            // The read end must NOT be inherited by the child
            SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);

            var si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            si.StartupInfo.hStdOutput = stdoutWrite;
            si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            si.lpAttributeList = attrList;

            // 7. Build command line
            var cmdLine = new StringBuilder(4096);
            cmdLine.Append('"').Append(exePath).Append('"');
            foreach (string arg in childArgs)
            {
                cmdLine.Append(' ');
                // Quote args that contain spaces
                if (arg.Contains(' ') || arg.Contains('"'))
                {
                    cmdLine.Append('"').Append(arg.Replace("\"", "\\\"")).Append('"');
                }
                else
                {
                    cmdLine.Append(arg);
                }
            }

            // 8. Creation flags
            uint createFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
            if (noWindow) createFlags |= CREATE_NO_WINDOW;

            // Build a sanitised environment block — strips HMAC key, model
            // API keys, and other secrets the AC child has no business seeing.
            // CreateProcessW(lpEnvironment = NULL) would inherit the launcher's
            // entire environment (which inherits the gateway's), leaking these.
            IntPtr envBlock = BuildSanitizedEnvBlock(out var strippedNames);

            if (!quiet)
            {
                Console.Error.WriteLine($"[AppContainerLauncher] Container: {containerName}");
                Console.Error.WriteLine($"[AppContainerLauncher] SID: {SidPtrToString(containerSidPtr)}");
                Console.Error.WriteLine($"[AppContainerLauncher] Capabilities: {string.Join(", ", capabilities)}");
                Console.Error.WriteLine($"[AppContainerLauncher] Command: {cmdLine}");
                Console.Error.WriteLine($"[AppContainerLauncher] WorkDir: {workDir ?? "(inherit)"}");
                if (strippedNames.Count > 0)
                    Console.Error.WriteLine($"[AppContainerLauncher] Stripped env: {string.Join(", ", strippedNames)}");
            }

            // 9. CreateProcess
            bool created;
            int createErr = 0;
            PROCESS_INFORMATION pi;
            try
            {
                created = CreateProcessW(
                    null,
                    cmdLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,           // inherit handles (for stdio)
                    createFlags,
                    envBlock,       // sanitised env (NOT inherited)
                    workDir,
                    ref si,
                    out pi);
                if (!created) createErr = Marshal.GetLastWin32Error();
            }
            finally
            {
                // Zero the secret-free env block before freeing, just to be tidy.
                Marshal.FreeHGlobal(envBlock);
            }

            if (!created)
            {
                throw new Win32Exception(createErr,
                    $"CreateProcess failed (error {createErr}): {new Win32Exception(createErr).Message}");
            }

            if (!quiet) Console.Error.WriteLine($"[AppContainerLauncher] Started PID: {pi.dwProcessId}");

            // Close the write end of the stdout pipe in the launcher process
            // so reads on stdoutRead will return EOF when the child exits.
            CloseHandle(stdoutWrite);

            // Forward child stdout from the pipe directly to the launcher's stdout.
            // Write raw bytes to avoid Console.Out re-encoding through
            // Console.OutputEncoding (which may differ from UTF-8 on CJK systems).
            var stdoutForwarder = Task.Run(() =>
            {
                using var stream = new FileStream(
                    new Microsoft.Win32.SafeHandles.SafeFileHandle(stdoutRead, ownsHandle: true),
                    FileAccess.Read, bufferSize: 4096, isAsync: false);
                using var consoleStdout = Console.OpenStandardOutput();
                var buf = new byte[4096];
                int n;
                while ((n = stream.Read(buf, 0, buf.Length)) > 0)
                    consoleStdout.Write(buf, 0, n);
            });

            // 10. Create a Job Object with kill-on-close so the child dies if the launcher is killed
            IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
            if (hJob != IntPtr.Zero)
            {
                var jobInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                jobInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(hJob, JobObjectExtendedLimitInformation,
                    ref jobInfo, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
                AssignProcessToJobObject(hJob, pi.hProcess);
            }

            // 11. Wait for child to exit
            WaitForSingleObject(pi.hProcess, INFINITE);
            GetExitCodeProcess(pi.hProcess, out uint exitCode);

            // Wait for stdout forwarding to finish (drain the pipe)
            stdoutForwarder.Wait();

            // 12. Cleanup handles
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);            if (hJob != IntPtr.Zero) CloseHandle(hJob);            DeleteProcThreadAttributeList(attrList);

            return (int)exitCode;
        }
        finally
        {
            // Restore stderr if it was suppressed
            if (savedStderr != null) Console.SetError(savedStderr);

            // Free container SID
            FreeSid(containerSidPtr);

            // Free all native allocations (in reverse order)
            for (int i = allocations.Count - 1; i >= 0; i--)
            {
                Marshal.FreeHGlobal(allocations[i]);
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private static string SidPtrToString(IntPtr sidPtr)
    {
        if (!ConvertSidToStringSidW(sidPtr, out IntPtr strPtr))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            return Marshal.PtrToStringUni(strPtr) ?? throw new InvalidOperationException("SID conversion returned null");
        }
        finally
        {
            LocalFree(strPtr);
        }
    }

    /// <summary>
    /// Check if the OS supports AppContainer (Windows 10 2004+, build 19041+).
    /// </summary>
    public static (bool Supported, int Build) CheckSupport()
    {
        var ver = Environment.OSVersion.Version;
        int build = ver.Build;
        // AppContainer for Win32 apps requires Windows 10 2004+ (build 19041)
        bool supported = ver.Major >= 10 && build >= 19041;
        return (supported, build);
    }

    /// <summary>
    /// One-time admin setup: grant traverse ACL on C:\ and C:\Users so that
    /// Node.js realpathSync() can walk the directory tree from inside AppContainer.
    /// Requires elevation (admin).
    /// </summary>
    public static void SetupDriveTraverse(string containerName)
    {
        string sidStr = EnsureProfile(containerName);
        var sid = new SecurityIdentifier(sidStr);

        // Grant traverse on all fixed drive roots so AppContainer processes can
        // reach paths on any drive (e.g. D:\Documents) when ACLs are granted.
        // Also grant C:\Users which Node.js realpathSync() needs.
        var dirs = new List<string>();

        // All fixed (local) drives
        foreach (var drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType == DriveType.Fixed && drive.IsReady)
            {
                dirs.Add(drive.RootDirectory.FullName);
            }
        }

        // C:\Users specifically (for realpathSync walk)
        string usersDir = Path.Combine(
            Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile))!,
            "Users");
        if (!dirs.Contains(usersDir, StringComparer.OrdinalIgnoreCase))
        {
            dirs.Add(usersDir);
        }

        foreach (string dir in dirs)
        {
            if (!Directory.Exists(dir)) continue;

            try
            {
                var info = new DirectoryInfo(dir);
                var security = info.GetAccessControl();

                // Check if already has traverse access
                var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier));
                bool hasAccess = false;
                foreach (FileSystemAccessRule rule in rules)
                {
                    if (rule.IdentityReference.Value == sidStr &&
                        rule.AccessControlType == AccessControlType.Allow &&
                        (rule.FileSystemRights & FileSystemRights.Traverse) != 0)
                    {
                        hasAccess = true;
                        break;
                    }
                }

                if (!hasAccess)
                {
                    // Safety: skip if DACL is NULL/empty — all access is already
                    // implied and writing back would wipe other principals.
                    if (IsNullOrEmptyDacl(security))
                    {
                        Console.Error.WriteLine($"[setup] SKIPPED — NULL/empty DACL (all access already implied): {dir}");
                        continue;
                    }

                    security.AddAccessRule(new FileSystemAccessRule(
                        sid,
                        FileSystemRights.ReadAttributes |
                        FileSystemRights.ReadExtendedAttributes | FileSystemRights.Traverse,
                        InheritanceFlags.None,
                        PropagationFlags.None,
                        AccessControlType.Allow));
                    info.SetAccessControl(security);
                    Console.Error.WriteLine($"[setup] Granted traverse: {dir}");
                }
                else
                {
                    Console.Error.WriteLine($"[setup] Already has traverse: {dir}");
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"[setup] ERROR: Need admin to set ACL on: {dir}");
                Console.Error.WriteLine($"[setup] Re-run this command as Administrator.");
                throw;
            }
        }

        Console.Error.WriteLine($"[setup] Done. AppContainer '{containerName}' can now resolve file paths.");
    }

    /// <summary>
    /// Delete gateway lock files whose owner PID is no longer alive.
    /// Prevents the AppContainer gateway from seeing stale locks (where
    /// process.kill(pid,0) returns EPERM instead of ESRCH).
    /// </summary>
    private static void CleanStaleLockFiles()
    {
        var tempDir = Path.GetTempPath();
        // Lock files live in %TEMP%/openclaw*/gateway.*.lock
        foreach (var dir in Directory.GetDirectories(tempDir, "openclaw*"))
        {
            foreach (var lockFile in Directory.GetFiles(dir, "gateway.*.lock"))
            {
                try
                {
                    var json = File.ReadAllText(lockFile);
                    // Quick parse: extract "pid":<number>
                    var match = System.Text.RegularExpressions.Regex.Match(json, @"""pid""\s*:\s*(\d+)");
                    if (!match.Success) continue;
                    int pid = int.Parse(match.Groups[1].Value);
                    try
                    {
                        System.Diagnostics.Process.GetProcessById(pid);
                        // Process exists — lock is live, don't touch
                    }
                    catch (ArgumentException)
                    {
                        // Process does not exist — stale lock
                        File.Delete(lockFile);
                        Console.Error.WriteLine($"[AppContainerLauncher] Cleaned stale lock: {Path.GetFileName(lockFile)} (pid {pid})");
                    }
                }
                catch { /* ignore individual file errors */ }
            }
        }
    }

    /// <summary>
    /// Add or remove loopback network exemption for the AppContainer.
    /// Uses checknetisolation.exe (requires elevation for persistent exemption).
    /// </summary>
    public static void SetLoopbackExemption(string containerName, bool enable)
    {
        string sidStr = EnsureProfile(containerName);

        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "checknetisolation",
            Arguments = enable
                ? $"LoopbackExempt -a -p={sidStr}"
                : $"LoopbackExempt -d -p={sidStr}",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var proc = System.Diagnostics.Process.Start(psi)!;
        proc.WaitForExit(10000);

        string output = proc.StandardOutput.ReadToEnd().Trim();
        string err = proc.StandardError.ReadToEnd().Trim();

        if (proc.ExitCode == 0)
        {
            Console.Error.WriteLine($"[loopback] {(enable ? "Added" : "Removed")} exemption for {containerName} ({sidStr})");
            if (!string.IsNullOrEmpty(output)) Console.Error.WriteLine($"[loopback] {output}");
        }
        else
        {
            Console.Error.WriteLine($"[loopback] Failed (exit {proc.ExitCode}): {err}");
        }
    }
}
