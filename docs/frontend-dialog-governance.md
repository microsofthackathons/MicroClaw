# Frontend Dialog Governance

## Purpose
This document defines how dialog-like surfaces are implemented and evolved in the renderer.
It enforces one Primitive source of truth and avoids mixed component systems.

## 1. Primitive Source of Truth

Decision:
- `UiButton`, `UiInput`, `UiDialog` are the primary Primitive source for modal dialogs.
- Dialog pages must not mix MAI UI primitives and local primitives as co-equal sources.

Rules:
- Use local primitives by default for dialog shell, primary/secondary actions, and text input controls.
- Keep `MAI UI` as an optional accelerator only when the scenario is standard and fit is high.

## 2. Layer Responsibilities

- Token layer:
  - Use semantic tokens from global theme variables.
  - No hard-coded hex values in dialog components.

- Primitive layer:
  - `UiDialog` defines shell behavior and visual frame.
  - `UiButton` and `UiInput` define action/input states.

- Business layer:
  - Business components own flow/state only (validation, async, provider logic, permission logic).

## 3. MAI UI Adoption Gate

A dialog is allowed to use MAI primitives only when all conditions are true:
- MAI component coverage is >= 80% of needed behavior.
- No custom keyboard/selection behavior needs to be overridden deeply.
- Token mapping remains consistent with app semantic variables.
- There is no duplicate primitive source on the same page.

If any condition fails, use local primitives.

## 4. Dialog Migration Priority

Current order:
1. `ModelSetupDialog` - uses local `UiButton` for the four main onboarding/footer actions. Its current provider catalog, connection-only editor, inline layout, local/Copilot flows, and config mutation checks remain authoritative. Existing Element Plus inputs/selects and the current modal/region shell are retained until their full behavior and label associations have equivalent primitive coverage.
2. `SettingsView` Add/Edit custom model dialogs - deferred as explicit TODO (no implementation change in this PR).
3. `Integrity` dialog in `App.vue` - keep stable now, migrate later.
4. `PermissionDialog` - keep business-first structure, only token/consistency improvements.
5. `UsagePanel` - treat as Drawer track; do not force-fit into dialog rules.

## 5. Drawer Track (Separate)

`UsagePanel` is a right drawer, not a modal dialog.
- It follows token consistency and action/input primitives where useful.
- Its shell behavior, layout, and animation are governed separately from `UiDialog`.
- Introduce `UiDrawer` only when at least two drawer use cases exist.

## 6. Definition of Done for Dialog Changes

Every dialog change must pass:
- Interaction consistency:
  - expected close behavior (overlay/close button/escape) is explicit and tested.
  - button hierarchy is clear (primary/secondary/destructive).
- Accessibility baseline:
  - keyboard reachable controls.
  - visible focus states.
  - meaningful aria labels where needed.
- Token compliance:
  - no new hard-coded visual values.
  - state colors and surfaces use semantic vars.
- Theme compatibility:
  - light and dark themes are both checked.

Use `docs/checklists/dialog-regression-checklist.md` for PR validation.

## 7. Deferred Scope Notes

Deferred in current PR:
- `SettingsView` Add Custom Model dialog migration.
- `SettingsView` Edit Custom Model dialog migration.

Why deferred:
- keep PR scope focused on existing primitive foundation and governance artifacts.
- avoid mixing behavior changes with ongoing branch stabilization.

Exit criteria for enabling this TODO:
- local dev run is stable and regression checklist can be executed end-to-end.
- explicit reviewer sign-off for dialog behavior parity (open/close, form submit, keyboard paths).

## 8. Storybook and Integration Boundary

- Storybook 10.6.5 is used with the current Vite 8 toolchain; the original Storybook 8 framework peer range only supports Vite 4–6.
- Docs and accessibility addons are explicit. Controls/actions come from Storybook core; the old essentials/interactions bundles are not carried forward.
- `UiInput` and `UiDialog` remain component examples and future migration building blocks. Their stories are not evidence of full product accessibility, focus management, or Electron behavior.
- The six F35 activation checks are ported to the current provider fixtures alongside every existing model setup test. Empty keys now follow the current disabled-until-valid-catalog contract, rather than the older preset-only validation path.
- Main's App, ChatView and GatewayLoading implementations are preserved, including native window controls, startup diagnostics, and permission/integrity lifecycles. Preview-only swallowed errors and removed Studio lifecycle code are not reintroduced.
