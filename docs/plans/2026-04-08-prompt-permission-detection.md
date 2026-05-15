# Prompt-Based Permission Detection

> **Status**: Proposed  
> **Date**: 2026-04-08  
> **Related**: sandbox-preload.js refactor, AppContainer permission system

## Problem

The current permission detection has blind spots:

1. **Scripts with try/catch** — Agent writes a script that catches `PermissionError` internally and outputs a custom message. Our stderr regex patterns don't match.
2. **Indirect access** — `python script.py` where the script accesses `C:\a` — the command line only shows the script path, not the actual denied path.
3. **Non-standard error formats** — Third-party tools may report permission errors in formats we haven't anticipated.
4. **Agent swallows errors** — Model sees "Access Denied" in tool output and describes it in natural language ("I couldn't access that directory") without the raw error.

In all these cases, AppContainer ACL still blocks the actual access at OS level, but no permission dialog appears — the user just sees a vague failure message.

## Proposed Solution

Add a **prompt-based detection layer** that complements (not replaces) the existing OS-level enforcement:

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: Prompt — Model outputs structured marker   │
│   → Desktop parses chat stream → triggers dialog    │
│                                                     │
│ Layer 2: Pre-block — Path extraction from command   │
│   → shouldBlockWrite/Read → sync IPC dialog         │
│                                                     │
│ Layer 3: Post-exec — stderr regex detection         │
│   → detectAccessDenied → async IPC dialog           │
│                                                     │
│ Layer 4: OS — AppContainer ACL (always enforced)    │
└─────────────────────────────────────────────────────┘
```

## Design

### 1. SOUL.md Instruction

Add to `DEFAULT_SOUL_MD` in `desktop/src/main.ts`:

```markdown
## Permission Error Reporting

When you encounter a permission error (Access Denied, PermissionError, EACCES,
UnauthorizedAccessException, etc.) during any operation — whether in a tool call
output, script execution result, or file operation — report it using this exact
format on its own line:

[PERMISSION_DENIED path="<the denied path>" access="<ro|rw>"]

Examples:
- [PERMISSION_DENIED path="C:\a" access="ro"]
- [PERMISSION_DENIED path="D:\projects\secret" access="rw"]

This lets the system detect and resolve the permission issue automatically.
Do NOT silently retry, work around the error, or suggest running as administrator.
```

### 2. Chat Stream Parsing (main.ts)

In the `chat:event` handler, scan accumulated text for the marker:

```typescript
const PERM_DENIED_RE = /\[PERMISSION_DENIED\s+path="([^"]+)"\s+access="(ro|rw)"\]/g;

// Track already-prompted paths to avoid duplicate dialogs
const promptDetectedPaths = new Set<string>();

function checkPromptPermissionMarkers(text: string): void {
  let match;
  while ((match = PERM_DENIED_RE.exec(text)) !== null) {
    const deniedPath = match[1];
    const access = match[2] as "ro" | "rw";
    const key = `${deniedPath.toLowerCase()}:${access}`;
    if (promptDetectedPaths.has(key)) continue;
    promptDetectedPaths.add(key);
    
    // Reuse existing async permission request flow
    handlePromptDetectedPermission(deniedPath, access);
  }
}
```

Call `checkPromptPermissionMarkers(streamText)` on each `delta` event, operating on the full accumulated text (not individual chunks) to avoid split-marker issues.

### 3. Permission Request Handler

```typescript
function handlePromptDetectedPermission(deniedPath: string, access: "ro" | "rw"): void {
  // Validate: must look like a real Windows path
  if (!/^[a-zA-Z]:\\/.test(deniedPath)) return;
  
  // Skip safe paths (same logic as sandbox-preload)
  const resolved = path.resolve(deniedPath).toLowerCase();
  if (isSafePath(resolved)) return;
  
  // Skip already-authorized paths
  const status = toolSandbox?.getStatus();
  if (status) {
    for (const rw of status.sandboxDirsRW) {
      if (resolved.startsWith(rw.toLowerCase())) return;
    }
    if (access === "ro") {
      for (const ro of status.sandboxDirsRO) {
        if (resolved.startsWith(ro.toLowerCase())) return;
      }
    }
  }
  
  // Send to renderer as async permission request (same dialog as stderr detection)
  const responseFile = path.join(approvalDir, `prompt-response-${Date.now().toString(36)}.json`);
  mainWindow?.webContents.send("sandbox:permission-request", {
    type: "prompt-detected",
    deniedPath,
    dirPath: inferDirPath(deniedPath),
    command: "(detected from model output)",
    accessNeeded: access,
    responseFile,
  });
}
```

### 4. Session Reset

Clear `promptDetectedPaths` on session change (same place where `sessionDeniedApps` is cleared).

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| Model doesn't obey prompt | This is supplementary — Layers 2-4 still work |
| Prompt injection fakes marker | Worst case: user sees an extra dialog. No security bypass — AppContainer still enforces |
| Token cost | Negligible — one paragraph in system prompt |
| Malformed path in marker | Validate with Windows path regex before processing |

## Scope

### Files to Change

| File | Change |
|------|--------|
| `desktop/src/main.ts` | Add `DEFAULT_SOUL_MD` paragraph, add chat delta parsing, add handler |
| `desktop/src/main.ts` | Clear `promptDetectedPaths` on session change |

### Not Changed

- `sandbox-preload.js` — No changes needed, OS-level enforcement unchanged
- `sandbox-permission.js` — No changes needed
- Gateway protocol — No changes needed

## Testing

1. **Manual**: Ask agent to read `C:\a` via a Python script with try/catch — verify dialog appears from prompt detection even though stderr pattern doesn't match
2. **Regression**: Verify existing pre-block and stderr detection still work (existing 162 tests)
3. **Dedup**: Trigger both stderr detection AND prompt marker — verify only one dialog appears
4. **Session reset**: Switch sessions — verify same path can trigger again

## Alternatives Considered

### A. Gateway-side tool call interception
- Requires Gateway protocol changes (`tool.approve`/`tool.deny`)
- Much higher complexity
- Better UX (pre-execution approval) but needs upstream changes

### B. Structured tool output format
- Define a JSON schema for tool error responses
- Gateway would need to enforce this format
- More reliable than free-text prompt but requires Gateway changes

### C. Do nothing
- Current system works for ~80% of cases
- The remaining 20% (try/catch, custom error messages) degrade to "model suggests running as admin"
- Acceptable but suboptimal UX

## Decision

Implement the prompt-based detection (this proposal) as a low-effort, low-risk improvement. Consider Gateway-side interception (Alternative A) as a future enhancement if prompt compliance proves insufficient.
