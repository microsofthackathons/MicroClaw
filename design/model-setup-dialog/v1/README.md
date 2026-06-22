# Model Setup Dialog Design v1

## Scope
- Improve selected-state clarity for provider cards.
- Unify selected ring and check colors with primary action color.
- Replace hardcoded red error/close-hover colors with MAI danger tokens.

## Decisions
- Selected card keeps a single visible selected border layer.
- Selected fill matches hover fill to avoid a blue tint bias.
- Error text and close-hover danger visuals use semantic tokens:
  - --smtc-status-danger-foreground
  - --smtc-status-danger-background

## Files Updated
- desktop/renderer/src/components/ModelSetupDialog.vue
- desktop/renderer/src/components/GatewayLoading.vue
- desktop/renderer/src/App.vue
- desktop/renderer/src/styles/global.css
- desktop/renderer/src/views/ChatView.vue

## Notes
- This version is intended for design iteration and review on branch design/model-setup-dialog/v1.
