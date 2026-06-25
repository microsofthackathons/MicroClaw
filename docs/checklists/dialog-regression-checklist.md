# Dialog Regression Checklist

Use this checklist for any PR that changes dialog or drawer UX.

## A. Core Interaction

- [ ] Open and close behavior matches product expectation.
- [ ] Overlay click behavior is intentional (`closeOnOverlay` decision documented).
- [ ] `Esc` behavior is intentional (enabled or intentionally blocked).
- [ ] Primary and secondary actions are in correct order and visual hierarchy.
- [ ] Loading/disabled states prevent duplicate submits.

## B. Keyboard and Focus

- [ ] All controls are reachable by keyboard.
- [ ] Focus ring is visible on all actionable controls.
- [ ] Enter key submits only where expected.
- [ ] Close control has accessible label.

## C. Visual and Token Compliance

- [ ] No newly introduced hard-coded colors for dialog UI.
- [ ] Border/surface/text/focus states use semantic variables.
- [ ] Spacing uses existing spacing rhythm.
- [ ] Typography and button sizes remain consistent with local primitives.

## D. Theme and Responsiveness

- [ ] Light theme verified.
- [ ] Dark theme verified.
- [ ] Narrow width behavior verified (content wrapping, footer button layout).

## E. Business Safety

- [ ] Validation errors are visible and understandable.
- [ ] Async failure path still returns to usable state.
- [ ] Existing behavior for high-risk flows (permission/integrity) remains unchanged unless intentionally modified.

## F. Primitive Source

- [ ] This page uses one primary primitive source for dialog shell/buttons/inputs.
- [ ] If MAI primitives are introduced, adoption gate rationale is documented in PR notes.
