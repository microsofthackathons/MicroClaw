# ACL Verification Timeout — Optimistic Grant with Silent Retry

> **Status**: Proposed  
> **Date**: 2026-04-09  
> **Related**: AppContainer sandbox, permission dialog, ACL propagation

## Problem

When the user approves a permission request, the desktop app:
1. Calls `AppContainerLauncher.exe grant` to set the ACL on the target dir
2. Polls `icacls` to verify the ACE appeared (200ms interval, 15s max)
3. Runs `dir .` inside AppContainer to verify actual access (8s timeout per attempt)

If step 2 or 3 times out, the current code **rolls back** the user's settings and writes a `"timeout"` response. This causes:
- User approved but sees a timeout error — frustrating
- Next access re-prompts — even more frustrating
- Settings are rolled back even though the ACL was actually set successfully

## Root Cause Analysis

The most likely root cause of verification timeout is **not** NTFS caching or inheritance propagation, but **incomplete ancestor traverse ACL**.

### The ACL grant order in `ContainerManager.GrantAccess()`:

```
Step 1: SetAccessControl(target dir)        ← ACE with ContainerInherit + ObjectInherit
Step 2: GrantAncestorTraverse(target dir)   ← traverse ACE on C:\, C:\Users, etc.
```

### The failure sequence:

```
T=0ms   grantDirAsync (non-elevated) → GrantAccess:
          SetAccessControl("D:\projects")    ✅ succeeds
          GrantAncestorTraverse("D:\")       ❌ UnauthorizedAccessException → break (needs admin)
T=10ms  GrantAccess returns (exit code 0 — no exception thrown to caller)

T=15ms  verifyAclPropagation starts polling:
          icacls "D:\projects"  → sees SID (M)       ✅ (icacls runs as normal user, not AC)
          verifyAclFromAppContainer:
            spawn AC process → cmd.exe "dir ."
            AC process traverses D:\ → NO traverse ACE → Access Denied  ❌
T=3.5s  Retry icacls ✅ → AC test ❌ (same reason)
T=7s    Retry icacls ✅ → AC test ❌
...
T=15s   TIMEOUT → rollback settings → write "timeout" response
```

The **target directory ACL is fine** — icacls confirms it. The problem is the **ancestor traverse** failed silently because it needs admin, but the first attempt was non-elevated. The code then falls through to `grantDirElevated`, which re-runs `GrantAccess` with admin — this time `GrantAncestorTraverse` succeeds. But this adds another round of grant + verify (another 15s+).

### Why `GrantAccess` reports success despite incomplete traverse:

```csharp
// GrantAncestorTraverse failure is caught and logged, but NOT re-thrown
try { GrantAncestorTraverse(containerName, dirPath); }
catch (Exception ex)
{
    Console.Error.WriteLine($"[grant] Warning: ancestor traverse for {dirPath}: {ex.Message}");
    // ← No re-throw! GrantAccess returns normally.
}
```

The caller (`grantDirAsync`) sees exit code 0 and thinks everything worked.

### Other possible causes (less common):

- **NTFS inheritance propagation** — `SetAccessControl` with `ContainerInherit | ObjectInherit` triggers async inheritance to child objects. Very large directories may take seconds. But this only affects child access, not `dir .` on the target directory itself.
- **New AC process, fresh token** — each `verifyAclFromAppContainer` spawns a brand new `AppContainerLauncher.exe → cmd.exe` process. New tokens don't have kernel-level ACL caching issues. The access check is real-time against the current NTFS Security Descriptor.

## Proposed Solution

Three-layer approach:

### Layer 1: Desktop — Differentiate "grant failed" vs "verify timed out"

**File**: `desktop/src/main.ts` — `grantAndVerifyAcl()`

Change `grantAndVerifyAcl` to return a 3-state result instead of boolean:

```typescript
type AclGrantResult = "verified" | "grant-ok-verify-timeout" | "failed";
```

- `"verified"` — ACL granted AND verified inside AppContainer.
- `"grant-ok-verify-timeout"` — `AppContainerLauncher.exe grant` returned success (exit 0), but `verifyAclPropagation` or `verifyAclFromAppContainer` timed out. ACL is on disk but may not be fully effective yet.
- `"failed"` — `AppContainerLauncher.exe grant` itself failed (both normal and elevated). ACL is NOT on disk.

The caller in `sandbox:permission-respond` then:

| Result | Settings | Response to gateway | UI notification |
|---|---|---|---|
| `"verified"` | Keep | Write `grant-rw`/`grant-ro` | None |
| `"grant-ok-verify-timeout"` | **Keep** (no rollback) | Write `grant-rw`/`grant-ro` | Info toast: "Permission granted — access may take a moment to propagate" |
| `"failed"` | **Rollback** | Write `timeout` | Error toast: "Could not set permission" |

### Layer 2: Desktop — When AC test fails, check/repair ancestor traverse before retrying

**File**: `desktop/src/main.ts` — `verifyAclPropagation()`

When icacls sees the ACE but `verifyAclFromAppContainer` fails, instead of blindly re-polling, **proactively check and repair ancestor traverse**:

```typescript
// Inside the polling loop, when icacls passes but AC test fails:
if (sidFound && !acOk && !ancestorRepairAttempted) {
  ancestorRepairAttempted = true;
  console.log(`[sandbox] ACL present but AC test failed — attempting ancestor traverse repair (elevated)`);
  await toolSandbox.grantAncestorTraverseElevated(dir);
  // Continue polling — next AC test should pass
}
```

This requires a new method on `ToolSandbox` that calls `AppContainerLauncher.exe grant-traverse --name MicroClaw --dir <path>` (or reuses the existing elevated grant path).

### Layer 3: Gateway — Silent retry on post-grant Access Denied

**File**: `appcontainer/sandbox-cp-hooks.js` — `handleAsyncAccessDenied()`

When Access Denied is detected for a path already in `_rwDirs` / `_roDirs`, don't immediately give up. Retry silently:

```javascript
if (inAuth) {
  // Directory is authorized but AppContainer still got Access Denied.
  // ACL propagation may still be in progress — retry silently.
  var MAX_ACL_RETRIES = 3;
  var ACL_RETRY_DELAY_MS = 1000;
  
  for (var retryIdx = 0; retryIdx < MAX_ACL_RETRIES; retryIdx++) {
    process.stderr.write('[sandbox] ACL propagation retry ' + (retryIdx + 1) 
      + '/' + MAX_ACL_RETRIES + ' for: ' + deniedPath + '\n');
    var buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ACL_RETRY_DELAY_MS);
    
    if (retryIdx === 0 && typeof process.send === 'function') {
      process.send({
        type: 'sandbox-acl-ineffective',
        deniedPath: deniedPath,
        dirPath: resolvedCheck,
        command: innerCmd ? innerCmd.substring(0, 500) : null,
      });
    }
  }
  
  process.stderr.write('[sandbox] ACL propagation retries exhausted for: ' + deniedPath + '\n');
  return false;
}
```

## Implementation

### Task 1: Enhanced logging in `grantAndVerifyAcl`

**File**: `desktop/src/main.ts`

Add structured timing logs throughout the entire grant+verify flow so we can diagnose exactly where time is spent:

```typescript
type AclGrantResult = "verified" | "grant-ok-verify-timeout" | "failed";

async function grantAndVerifyAcl(dir: string, access: "rw" | "r"): Promise<AclGrantResult> {
  if (!toolSandbox) return "failed";
  const t0 = Date.now();
  const log = (msg: string) => console.log(`[sandbox:grant] [+${Date.now() - t0}ms] ${msg}`);

  const needsAdmin = likelyNeedsElevation(dir);
  log(`start dir=${dir} access=${access} needsAdmin=${needsAdmin}`);

  // Try non-elevated first (unless needs admin)
  if (!needsAdmin) {
    log(`grantDirAsync start (non-elevated)`);
    const ok = await toolSandbox.grantDirAsync(dir, access, true);
    log(`grantDirAsync result=${ok}`);
    if (ok) {
      log(`verifyAclPropagation start`);
      const verified = await verifyAclPropagation(dir, access);
      log(`verifyAclPropagation result=${verified}`);
      if (verified) return "verified";
      log(`grant OK but verify timed out — proceeding optimistically`);
      return "grant-ok-verify-timeout";
    }
    log(`non-elevated grant failed — trying elevated`);
  }

  // Elevated attempt
  log(`grantDirElevated start`);
  const ok = await toolSandbox.grantDirElevated(dir, access, true);
  log(`grantDirElevated result=${ok}`);
  if (ok) {
    log(`verifyAclPropagation start (post-elevated)`);
    const verified = await verifyAclPropagation(dir, access);
    log(`verifyAclPropagation result=${verified}`);
    if (verified) return "verified";
    log(`elevated grant OK but verify timed out — proceeding optimistically`);
    return "grant-ok-verify-timeout";
  }

  log(`ALL grant attempts failed`);
  return "failed";
}
```

### Task 2: Enhanced logging in `verifyAclPropagation`

**File**: `desktop/src/main.ts`

Add per-iteration logs and ancestor traverse repair:

```typescript
async function verifyAclPropagation(dir: string, access: "rw" | "r" = "r"): Promise<boolean> {
  if (!_appContainerSid) {
    console.warn("[sandbox:verify] no SID cached — adding 500ms safety delay");
    await new Promise(r => setTimeout(r, 500));
    return true;
  }
  const sid = _appContainerSid;
  const maxWait = 15000;
  const interval = 200;
  const start = Date.now();
  let iteration = 0;
  let icaclsPassCount = 0;
  let acTestCount = 0;
  let ancestorRepairAttempted = false;

  while (Date.now() - start < maxWait) {
    iteration++;
    const elapsed = Date.now() - start;
    try {
      const { execSync } = require("child_process");
      const output = execSync(`icacls "${dir}"`, {
        windowsHide: true, timeout: 3000, encoding: "utf-8",
      }) as string;
      const sidIdx = output.indexOf(sid);
      if (sidIdx >= 0) {
        const afterSid = output.substring(sidIdx + sid.length, sidIdx + sid.length + 50);
        const rwMatch = /\(M\)|\(F\)/.test(afterSid);
        if (access === "rw" && !rwMatch) {
          // SID found but wrong access level — keep polling
          console.log(`[sandbox:verify] [+${elapsed}ms] iter=${iteration} icacls SID found but no (M)/(F): ${afterSid.trim()}`);
          await new Promise(r => setTimeout(r, interval));
          continue;
        }
        icaclsPassCount++;
        console.log(`[sandbox:verify] [+${elapsed}ms] iter=${iteration} icacls PASS (${access === "rw" ? "RW" : "RO"}) — starting AC test #${acTestCount + 1}`);
        
        acTestCount++;
        const acOk = await verifyAclFromAppContainer(dir);
        const acElapsed = Date.now() - start;
        
        if (acOk) {
          console.log(`[sandbox:verify] [+${acElapsed}ms] AC test PASS — verified (icacls_passes=${icaclsPassCount} ac_tests=${acTestCount})`);
          return true;
        }
        
        console.log(`[sandbox:verify] [+${acElapsed}ms] AC test FAIL #${acTestCount} (icacls passed but AC can't access — likely ancestor traverse issue)`);
        
        // After first AC failure: attempt ancestor traverse repair
        if (!ancestorRepairAttempted && toolSandbox) {
          ancestorRepairAttempted = true;
          console.log(`[sandbox:verify] [+${acElapsed}ms] attempting ancestor traverse repair (elevated)`);
          try {
            await toolSandbox.grantDirElevated(dir, access, false); // re-grant with admin, triggers GrantAncestorTraverse
            console.log(`[sandbox:verify] [+${Date.now() - start}ms] ancestor traverse repair done — will retry AC test`);
          } catch (err: any) {
            console.warn(`[sandbox:verify] ancestor traverse repair failed: ${err.message}`);
          }
        }
      } else {
        if (iteration % 10 === 1) { // Log every ~2 seconds
          console.log(`[sandbox:verify] [+${elapsed}ms] iter=${iteration} icacls: SID not found yet`);
        }
      }
    } catch (err: any) {
      if (iteration === 1) {
        console.warn(`[sandbox:verify] [+${elapsed}ms] icacls error: ${err.message}`);
      }
    }
    await new Promise(r => setTimeout(r, interval));
  }

  const totalElapsed = Date.now() - start;
  console.warn(`[sandbox:verify] TIMEOUT after ${totalElapsed}ms — iterations=${iteration} icacls_passes=${icaclsPassCount} ac_tests=${acTestCount} ancestor_repair=${ancestorRepairAttempted}`);
  return false;
}
```

### Task 3: Enhanced logging in `verifyAclFromAppContainer`

**File**: `desktop/src/main.ts`

```typescript
async function verifyAclFromAppContainer(dir: string): Promise<boolean> {
  if (!toolSandbox?.isAvailable()) return true;
  const cleanDir = normalizeDirPath(dir);
  const t0 = Date.now();
  try {
    const result = await toolSandbox.execShell("dir .", { timeout: 8000, skipSetup: true, cwd: cleanDir });
    const elapsed = Date.now() - t0;
    if (result.exitCode === 0) {
      console.log(`[sandbox:ac-test] PASS in ${elapsed}ms for: ${cleanDir}`);
      return true;
    }
    console.log(`[sandbox:ac-test] FAIL in ${elapsed}ms exit=${result.exitCode} for: ${cleanDir} stderr=${result.stderr?.substring(0, 300)}`);
    return false;
  } catch (err: any) {
    console.log(`[sandbox:ac-test] ERROR in ${Date.now() - t0}ms for: ${cleanDir}: ${err.message}`);
    return false;
  }
}
```

### Task 4: Enhanced logging in `AppContainerLauncher` (C#)

**File**: `appcontainer/ContainerManager.cs` — `GrantAccess()`

Add timing and status output:

```csharp
public static void GrantAccess(string containerName, string dirPath, bool readOnly)
{
    var sw = System.Diagnostics.Stopwatch.StartNew();
    
    if (HasAllAppPackagesAccess(dirPath, readOnly))
    {
        Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] Skipped — ALL APPLICATION PACKAGES already has access: {dirPath}");
        return;
    }

    string sidStr = EnsureProfile(containerName);
    Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] SID resolved: {sidStr}");
    
    var sid = new SecurityIdentifier(sidStr);
    // ... SetAccessControl ...
    Console.Error.WriteLine($"[grant] [{sw.ElapsedMilliseconds}ms] SetAccessControl done for: {dirPath}");

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
}
```

### Task 5: Enhanced logging in `GrantAncestorTraverse` (C#)

**File**: `appcontainer/ContainerManager.cs`

Log each ancestor directory attempt:

```csharp
public static void GrantAncestorTraverse(string containerName, string dirPath)
{
    string sidStr = EnsureProfile(containerName);
    var sid = new SecurityIdentifier(sidStr);

    string? current = Path.GetDirectoryName(Path.GetFullPath(dirPath));
    while (current != null)
    {
        try
        {
            var info = new DirectoryInfo(current);
            var security = info.GetAccessControl();
            // ... check hasAccess ...
            if (!hasAccess)
            {
                security.AddAccessRule(...);
                info.SetAccessControl(security);
                Console.Error.WriteLine($"[traverse] Granted: {current}");
            }
            else
            {
                Console.Error.WriteLine($"[traverse] Already has access: {current}");
            }
        }
        catch (UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"[traverse] BLOCKED (need admin): {current}");
            break;  // ← This break is the likely root cause of verification timeouts
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[traverse] Error for {current}: {ex.Message}");
        }

        current = Path.GetDirectoryName(current);
    }
}
```

### Task 6: Update `sandbox:permission-respond` handler

**File**: `desktop/src/main.ts`

For both file and shell permission types, change the timeout handling:

```typescript
const t0 = Date.now();
console.log(`[sandbox:respond] starting grant for ${dirToAdd} access=${access}`);
const granted = await grantAndVerifyAcl(dirToAdd, access);
console.log(`[sandbox:respond] grant result=${granted} elapsed=${Date.now() - t0}ms`);

if (granted === "failed") {
  // ACL not set at all — rollback settings, write timeout response
  console.warn(`[sandbox:respond] FAILED — rolling back settings for ${dirToAdd}`);
  // (existing rollback logic stays here)
  ...
  fs.writeFileSync(responseFile, JSON.stringify({ id, decision: "timeout" }), "utf-8");
  return;
}

if (granted === "grant-ok-verify-timeout") {
  // ACL set but not yet verified — keep settings, proceed with grant
  console.log(`[sandbox:respond] OPTIMISTIC — grant OK but verify timed out, keeping settings for ${dirToAdd}`);
  mainWindow?.webContents.send("sandbox:acl-propagation-pending", {
    dir: dirToAdd, access,
  });
}

// Both "verified" and "grant-ok-verify-timeout" proceed here
console.log(`[sandbox:respond] writing grant response for ${dirToAdd}`);
```

### Task 7: Gateway silent retry on post-grant Access Denied

**File**: `appcontainer/sandbox-cp-hooks.js`

At ~line 310, where Access Denied is detected for an already-authorized directory:

```javascript
if (inAuth) {
  var MAX_ACL_RETRIES = 3;
  var ACL_RETRY_DELAY_MS = 1000;
  
  for (var retryIdx = 0; retryIdx < MAX_ACL_RETRIES; retryIdx++) {
    process.stderr.write('[sandbox] ACL retry ' + (retryIdx + 1) 
      + '/' + MAX_ACL_RETRIES + ' after ' + ACL_RETRY_DELAY_MS 
      + 'ms for authorized path: ' + deniedPath + '\n');
    
    var buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ACL_RETRY_DELAY_MS);
    
    if (retryIdx === 0 && typeof process.send === 'function') {
      process.send({
        type: 'sandbox-acl-ineffective',
        deniedPath: deniedPath,
        dirPath: resolvedCheck,
        command: innerCmd ? innerCmd.substring(0, 500) : null,
      });
    }
  }
  
  process.stderr.write('[sandbox] ACL retries exhausted (' + MAX_ACL_RETRIES 
    + 'x ' + ACL_RETRY_DELAY_MS + 'ms) for: ' + deniedPath + '\n');
  return false;
}
```

## Log Output Example (expected for the timeout scenario)

```
[sandbox:respond] starting grant for D:\projects access=rw
[sandbox:grant] [+0ms] start dir=D:\projects access=rw needsAdmin=false
[sandbox:grant] [+1ms] grantDirAsync start (non-elevated)
[grant] [0ms] SID resolved: S-1-15-2-xxxx
[grant] [5ms] SetAccessControl done for: D:\projects
[traverse] Already has access: D:\
   — OR —
[traverse] BLOCKED (need admin): D:\          ← ROOT CAUSE VISIBLE HERE
[grant] [8ms] WARNING: GrantAncestorTraverse FAILED for D:\projects: Access to the path 'D:\' is denied.
[grant] [8ms] GrantAccess complete for: D:\projects (readOnly=False)
[sandbox:grant] [+15ms] grantDirAsync result=true
[sandbox:grant] [+15ms] verifyAclPropagation start
[sandbox:verify] [+20ms] iter=1 icacls PASS (RW) — starting AC test #1
[sandbox:ac-test] FAIL in 3200ms exit=1 for: D:\projects\ stderr=Access is denied.
[sandbox:verify] [+3220ms] AC test FAIL #1 (icacls passed but AC can't access — likely ancestor traverse issue)
[sandbox:verify] [+3220ms] attempting ancestor traverse repair (elevated)
  — UAC prompt appears, user clicks Yes —
[sandbox:verify] [+5500ms] ancestor traverse repair done — will retry AC test
[sandbox:verify] [+5700ms] iter=28 icacls PASS (RW) — starting AC test #2
[sandbox:ac-test] PASS in 2800ms for: D:\projects\
[sandbox:verify] [+8500ms] AC test PASS — verified (icacls_passes=28 ac_tests=2)
[sandbox:grant] [+8500ms] verifyAclPropagation result=true
[sandbox:respond] grant result=verified elapsed=8515ms
[sandbox:respond] writing grant response for D:\projects
```

## Verification Timeout Value

`verifyAclPropagation` timeout remains **15 seconds**. With ancestor repair, most cases should resolve within 5-10 seconds:
- First AC test fail: ~3s (spawn + timeout)
- Ancestor repair: ~2s (elevated grant)
- Second AC test pass: ~3s
- **Total: ~8s** (well within 15s)

## Security Analysis

**No security downgrade:**
- ACL IS set on disk (grant returned exit 0)
- AppContainer enforcement remains — OS will allow access once traverse is complete
- Settings only kept when grant succeeded — if grant fails, we still rollback
- Silent retry only for already-authorized paths — no escalation
- Ancestor traverse repair uses the same elevated grant path (UAC required)
