# Skill Mid-Session Change Detection — Design Document (Stub)

**Status:** Deferred — to be discussed after Task 1 (Integrity Check) is implemented.

**Goal:** Detect when managed skills are installed, modified, or removed while the desktop app is running (e.g. a user installs a skill via clawhub through chat), without requiring an app restart.

---

## 1. Problem Statement

Currently, skill integrity is only checked at startup. If a user installs a new skill mid-session (via clawhub in chat, or by manually copying files), the desktop app has no awareness of the change until next launch. This creates a window where:

- A newly installed skill bypasses integrity verification
- A skill modified during the session goes undetected
- The integrity snapshot becomes stale

---

## 2. Known Approaches

### Option A: File watcher in desktop main process

- Use `fs.watch()` or `chokidar` in `main.ts` to watch skill directories
- On change → re-compute hashes → compare to snapshot → notify renderer
- **Pro:** Real-time detection
- **Con:** File watcher reliability on Windows, performance with many files

### Option B: Periodic polling

- Poll skill directories every N seconds (e.g. 60s)
- Compare file list + mtimes against last known state
- Only compute full hashes if mtime changed
- **Pro:** Simple, reliable
- **Con:** Detection delay up to N seconds

### Option C: Gateway event forwarding

- OpenClaw gateway already has `chokidar` watching `~/.openclaw/skills/*/SKILL.md`
- Emit skill change events via WebSocket to desktop app
- Desktop app receives event → re-verify integrity
- **Pro:** Leverages existing infrastructure, no duplicate watchers
- **Con:** Requires gateway-side changes (possibly in openclaw upstream), only watches SKILL.md not all files

---

## 3. Open Questions

- Which skill directories need mid-session monitoring? (managed only, or all?)
- Should mid-session changes trigger the same full alert dialog, or a lighter notification?
- Should the gateway be responsible for notifying the desktop app, or should the desktop app independently monitor?
- How does this interact with the "Trust & Continue" flow — if user trusted changes at startup, should mid-session changes for the same skill re-trigger alerts?
- How does clawhub skill installation actually work end-to-end? (Affects which approach is viable)

---

## 4. Dependencies

- Task 1 (Integrity Check) must be implemented first — mid-session detection reuses the same snapshot format, hashing logic, and verification code
- Understanding the real workspace directory structure (deferred from managed skill control work)
- Clarity on gateway ↔ desktop event protocol

---

## 5. Demo Scenario (Future)

1. MicroClaw is running with clean state
2. User installs a new skill via clawhub in the chat window
3. Desktop app immediately shows a notification: "New skill detected: fancy-tool — verify and trust?"
4. User clicks Trust → snapshot updated, skill available
5. **Talking point:** "Real-time protection, not just at startup"

---

*This document will be expanded after Task 1 is complete and the workspace structure is finalized.*
