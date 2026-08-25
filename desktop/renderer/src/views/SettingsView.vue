<template>
  <div class="settings-view">
    <!-- Left sidebar: icon grid nav -->
    <div class="settings-sidebar">
      <div class="menu-list">
        <div
          v-for="item in menuItems"
          :key="item.id"
          class="settings-menu-item"
          :class="{ active: activeSection === item.id }"
          @click="activeSection = item.id"
        >
          <span class="menu-icon" :style="{ background: item.color }" v-html="item.svg"></span>
          <span class="menu-label">{{ item.label }}</span>
        </div>
      </div>
    </div>

    <!-- Right content: grouped card rows -->
    <div
      class="settings-content"
      :class="{ 'settings-content--skills': devSettingsEnabled && activeSection === 'skills' }"
    >
      <!-- General -->
      <div v-if="activeSection === 'general'" class="section">
        <div class="section-label">{{ t("settings.application") }}</div>
        <div class="card-group">
          <div v-show="false" class="card-row">
            <label class="row-label" for="settings-language-select">
              {{ t("settings.language") }}
            </label>
            <select
              id="settings-language-select"
              v-model="settings.language"
              class="language-select"
              :aria-label="t('settings.language')"
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.autoStart") }}</span>
            <el-switch v-model="settings.autoStart" />
          </div>
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.minimizeToTray") }}</span>
            <el-switch v-model="settings.minimizeToTray" />
          </div>
        </div>

        <div class="sub-label">{{ t("settings.theme") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.themeMode") }}</span>
            <el-radio-group v-model="settings.themeMode" size="small">
              <el-radio value="light">{{ t("settings.themeLight") }}</el-radio>
              <el-radio value="dark">{{ t("settings.themeDark") }}</el-radio>
              <el-radio value="system">{{ t("settings.themeSystem") }}</el-radio>
            </el-radio-group>
          </div>
        </div>

        <div class="sub-label-row">
          <span class="sub-label" style="margin-bottom: 0">{{ t("settings.gateway") }}</span>
          <span
            class="status-indicator"
            :class="
              gateway.status === 'running' ? 'status-indicator--ok' : 'status-indicator--error'
            "
          >
            <span class="status-dot"></span>
            {{ gateway.status === "running" ? t("settings.connected") : gateway.status }}
          </span>
        </div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.restartGateway") }}</span>
            <div style="display: flex; align-items: center; gap: 8px">
              <el-button size="small" @click="restartGateway">{{
                t("settings.restart")
              }}</el-button>
            </div>
          </div>
        </div>

        <div class="sub-label">{{ t("settings.logs") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.gatewayLog") }}</span>
            <el-button
              size="small"
              :loading="exportingGatewayLogs"
              :disabled="gateway.logs.length === 0"
              @click="exportGatewayLogs"
              >{{ t("settings.export") }}</el-button
            >
          </div>
        </div>
      </div>

      <!-- Usage -->
      <div v-if="activeSection === 'usage'" class="section">
        <div class="section-label-row">
          <span class="section-label">{{ t("settings.usage") }}</span>
          <button
            v-if="usageData"
            class="usage-refresh-btn"
            type="button"
            :aria-label="t('settings.refresh')"
            :title="t('settings.refresh')"
            :disabled="usageLoading"
            @click="loadUsage"
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              :class="{ 'is-spinning': usageLoading }"
              aria-hidden="true"
            >
              <path d="M16 7a6 6 0 0 0-10.2-2.8L4 6" />
              <path d="M4 3v3h3" />
              <path d="M4 13a6 6 0 0 0 10.2 2.8L16 14" />
              <path d="M16 17v-3h-3" />
            </svg>
          </button>
        </div>

        <!-- Loading / Error states -->
        <div v-if="usageLoading" class="card-group">
          <div class="card-row no-border placeholder-row">
            <span class="placeholder-text">{{ t("settings.usageLoading") }}</span>
          </div>
        </div>
        <div v-else-if="usageError" class="card-group">
          <div class="card-row no-border placeholder-row">
            <span class="placeholder-text" style="color: var(--text-muted)">{{ usageError }}</span>
          </div>
          <div class="card-row no-border" style="justify-content: center; padding-top: 0">
            <el-button size="small" @click="loadUsage">{{ t("settings.retry") }}</el-button>
          </div>
        </div>

        <!-- Data loaded -->
        <template v-else-if="usageData">
          <!-- Spend overview -->
          <div class="card-group">
            <div class="card-row" :class="{ 'no-border': !usageData.maxBudget }">
              <span class="row-label">{{ t("settings.totalSpend") }}</span>
              <span class="row-value usage-spend"
                >{{ t("settings.currencySymbol")
                }}{{ toCny(usageData.totalSpend).toFixed(2) }}</span
              >
            </div>
            <div v-if="usageData.maxBudget" class="card-row no-border">
              <span class="row-label">{{ t("settings.budget") }}</span>
              <div class="budget-bar-wrapper">
                <span class="row-value"
                  >{{ t("settings.currencySymbol") }}{{ toCny(usageData.totalSpend).toFixed(2) }} /
                  {{ t("settings.currencySymbol")
                  }}{{ toCny(usageData.maxBudget).toFixed(2) }}</span
                >
                <div class="budget-bar">
                  <div
                    class="budget-bar-fill"
                    :style="{
                      width:
                        Math.min(100, (usageData.totalSpend / usageData.maxBudget) * 100) + '%',
                    }"
                  ></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Token usage (from detailed logs) -->
          <template v-if="usageData.hasDetailedLogs">
            <div class="sub-label">{{ t("settings.tokenUsage30d") }}</div>
            <div class="card-group">
              <div class="card-row">
                <span class="row-label">{{ t("settings.sessionCount") }}</span>
                <span class="row-value">{{ (usageData.sessionCount || 0).toLocaleString() }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.messageCount") }}</span>
                <span class="row-value">{{ usageData.totalRequests.toLocaleString() }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.inputTokens") }}</span>
                <span class="row-value">{{ usageData.totalPromptTokens.toLocaleString() }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.outputTokens") }}</span>
                <span class="row-value">{{
                  usageData.totalCompletionTokens.toLocaleString()
                }}</span>
              </div>
              <div v-if="usageData.cacheReadTokens" class="card-row">
                <span class="row-label">{{ t("settings.cacheReadTokens") }}</span>
                <span class="row-value">{{ usageData.cacheReadTokens.toLocaleString() }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.totalTokens") }}</span>
                <span class="row-value">{{ usageData.totalTokens.toLocaleString() }}</span>
              </div>
              <div v-if="usageData.toolCalls" class="card-row no-border">
                <span class="row-label">{{ t("settings.toolCalls") }}</span>
                <span class="row-value">{{ usageData.toolCalls.toLocaleString() }}</span>
              </div>
            </div>
          </template>

          <!-- Per-model breakdown -->
          <template v-if="usageModelList.length">
            <div class="sub-label">{{ t("settings.modelBreakdown") }}</div>
            <div class="card-group">
              <div
                v-for="(m, idx) in usageModelList"
                :key="m.name"
                class="card-row"
                :class="{ 'no-border': idx === usageModelList.length - 1 }"
              >
                <div class="model-usage-info">
                  <span class="row-label">{{ m.name }}</span>
                  <span class="row-sub" v-if="m.requests"
                    >{{ m.requests }} {{ t("settings.callsSuffix") }} ·
                    {{ m.promptTokens.toLocaleString() }} {{ t("settings.inputSuffix") }} ·
                    {{ m.completionTokens.toLocaleString() }} {{ t("settings.outputSuffix") }}</span
                  >
                </div>
                <span class="row-value usage-spend"
                  >{{ t("settings.currencySymbol") }}{{ toCny(m.spend).toFixed(2) }}</span
                >
              </div>
            </div>
          </template>
        </template>

        <div class="section-footer">{{ t("settings.usageFooter") }}</div>
      </div>

      <!-- Models -->
      <div v-if="activeSection === 'models'" class="section">
        <!-- Model -->
        <div class="sub-label-row">
          <span class="sub-label">{{ t("settings.customModels") }}</span>
          <div v-if="customModels.length" class="sub-label-actions">
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="
                Boolean(switchingModelRef) || Boolean(removingModelRef) || copilotDisconnecting
              "
              @click="showProviderSetup = true"
            >
              {{ t("settings.setUpProvider") }}
            </el-button>
            <el-button
              v-if="selectedModelEntry?.source !== 'auth-managed' && selectedModelIndex >= 0"
              size="small"
              type="danger"
              plain
              :loading="removingModelRef === selectedModel"
              :disabled="Boolean(switchingModelRef) || Boolean(removingModelRef)"
              @click="removeCustomModel(selectedModelIndex)"
            >
              {{ t("settings.delete") }}
            </el-button>
            <el-button
              v-else-if="selectedModelEntry?.providerKey === 'github-copilot'"
              size="small"
              type="danger"
              plain
              :loading="copilotDisconnecting"
              :disabled="Boolean(switchingModelRef) || Boolean(removingModelRef)"
              @click="disconnectGitHubCopilot"
            >
              {{ t("settings.disconnect") }}
            </el-button>
          </div>
        </div>
        <div class="card-group">
          <template v-if="customModels.length">
            <div class="card-row">
              <span class="row-label">{{ t("settings.provider") }}</span>
              <span class="row-value">{{ currentProviderName }}</span>
            </div>
            <div class="card-row no-border">
              <span class="row-label">{{ t("settings.currentModel") }}</span>
              <div class="model-picker-actions">
                <el-select
                  class="model-picker-select"
                  :model-value="selectedModel"
                  :loading="
                    Boolean(switchingModelRef) || Boolean(removingModelRef) || copilotDisconnecting
                  "
                  :disabled="
                    Boolean(switchingModelRef) || Boolean(removingModelRef) || copilotDisconnecting
                  "
                  filterable
                  @change="selectModel"
                >
                  <el-option
                    v-for="model in customModels"
                    :key="getModelRef(model)"
                    :label="model.name"
                    :value="getModelRef(model)"
                  />
                </el-select>
              </div>
            </div>
          </template>
          <div v-else-if="!copilotModelsLoading" class="card-row no-border">
            <span class="placeholder-text">{{ t("settings.noProviderConfigured") }}</span>
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="
                Boolean(switchingModelRef) || Boolean(removingModelRef) || copilotDisconnecting
              "
              @click="showProviderSetup = true"
            >
              {{ t("settings.setUpModelProvider") }}
            </el-button>
          </div>
        </div>

        <!-- Web search -->
        <div class="sub-label-row">
          <span class="sub-label">{{ t("settings.webSearch") }}</span>
          <div class="sub-label-actions">
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="!searchDirty"
              :loading="searchSavingAll"
              @click="saveSearchSettings"
              >{{ t("settings.save") }}</el-button
            >
          </div>
        </div>
        <div class="card-group">
          <div class="card-row">
            <span class="row-label">{{ t("settings.provider") }}</span>
            <el-select v-model="searchProvider" style="width: 130px">
              <el-option v-for="p in searchProviders" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
          </div>
          <div v-if="activeSearchProvider.requiresKey" class="card-row no-border api-key-row">
            <span class="row-label">{{ t("settings.apiKey") }}</span>
            <a
              href="#"
              class="provider-link"
              @click.prevent="openExternal(activeSearchProvider.link)"
              >{{ t("settings.getApiKey") }}<span class="provider-link-arrow">↗</span></a
            >
            <el-input
              v-model="searchKeys[searchProvider]"
              type="password"
              show-password
              :placeholder="activeSearchProvider.placeholder"
              class="provider-key-input"
            />
          </div>
          <div v-else class="card-row no-border">
            <span class="row-label">{{ t("settings.apiKey") }}</span>
            <span class="placeholder-text">{{ t("settings.noApiKeyRequired") }}</span>
          </div>
        </div>
        <div class="section-footer">{{ t("settings.webSearchDesc") }}</div>
      </div>

      <!-- Channels -->
      <ChannelsView v-if="activeSection === 'channels'" embedded />

      <!-- Skills (development builds only) -->
      <component
        :is="SkillsDevPanel"
        v-if="devSettingsEnabled && SkillsDevPanel && activeSection === 'skills'"
      />

      <!-- Security / Sandbox -->
      <div v-if="activeSection === 'security'" class="section">
        <div class="section-label">{{ t("settings.security") }}</div>
        <div class="card-group mxc-card">
          <div class="card-row">
            <div>
              <span class="row-label">{{ t("settings.windowsNodeMxc") }}</span>
              <div class="mxc-subtitle">{{ t("settings.windowsNodeMxcExperimental") }}</div>
            </div>
            <el-switch
              :model-value="windowsNodeMxcStatus?.desiredEnabled ?? false"
              :loading="windowsNodeMxcApplying"
              @change="toggleWindowsNodeMxc"
            />
          </div>
          <template v-if="windowsNodeMxcStatus">
            <div class="card-row">
              <span class="row-label">{{ t("settings.windowsNodeMxcEffective") }}</span>
              <span class="mxc-state" :class="windowsNodeMxcProtectionClass">
                {{ windowsNodeMxcProtectionLabel }}
              </span>
            </div>
            <div v-if="windowsNodeMxcProtectionDetail" class="mxc-primary-detail">
              {{ windowsNodeMxcProtectionDetail }}
            </div>
            <div
              class="card-row no-border mxc-folder-policy"
              style="flex-direction: column; align-items: stretch"
            >
              <span class="row-label">{{ t("settings.windowsNodeMxcFolders") }}</span>
              <div class="mxc-folder-policy-hint">
                {{ t("settings.windowsNodeMxcFoldersHint") }}
              </div>
              <div
                v-if="windowsNodeMxcStatus.desiredEnabled"
                class="mxc-alert mxc-alert-warning mxc-folder-policy-locked"
              >
                {{ t("settings.windowsNodeMxcFoldersStaged") }}
              </div>
              <div
                v-if="windowsNodeMxcStatus.folderPolicyRecovery?.lastError"
                class="mxc-alert mxc-alert-error"
              >
                {{ t("settings.windowsNodeMxcFolderRecovery") }}:
                {{ windowsNodeMxcStatus.folderPolicyRecovery.lastError }}
                <el-button text size="small" @click="stagePreviousWindowsNodeMxcFolderPolicy">
                  {{ t("settings.windowsNodeMxcStagePreviousFolders") }}
                </el-button>
              </div>
              <div class="dir-section">
                <div class="mxc-folder-policy-heading">
                  <span class="dir-section-label">{{ t("settings.sandboxDirsRW") }}</span>
                  <el-button
                    data-testid="mxc-add-rw"
                    size="small"
                    type="primary"
                    plain
                    :disabled="windowsNodeMxcFolderApplying"
                    @click="addWindowsNodeMxcFolder('rw')"
                  >
                    {{ t("settings.sandboxAddDir") }}
                  </el-button>
                </div>
                <div
                  v-for="dir in windowsNodeMxcFolderDraft.rw"
                  :key="'mxc-rw-' + dir"
                  class="dir-item"
                >
                  <span class="dir-path" :title="dir">{{ dir }}</span>
                  <span class="dir-badge dir-badge-rw">RW</span>
                  <el-button
                    data-testid="mxc-change-ro"
                    text
                    size="small"
                    :disabled="windowsNodeMxcFolderApplying"
                    @click="changeWindowsNodeMxcFolderAccess(dir, 'ro')"
                  >
                    {{ t("settings.windowsNodeMxcChangeToRo") }}
                  </el-button>
                  <button
                    class="tag-remove"
                    :disabled="windowsNodeMxcFolderApplying"
                    @click="removeWindowsNodeMxcFolder(dir, 'rw')"
                  >
                    &times;
                  </button>
                </div>
                <div v-if="windowsNodeMxcFolderDraft.rw.length === 0" class="dir-empty">
                  {{ t("settings.sandboxNoDirs") }}
                </div>
              </div>
              <div class="dir-section" style="margin-top: 10px">
                <div class="mxc-folder-policy-heading">
                  <span class="dir-section-label">{{ t("settings.sandboxDirsRO") }}</span>
                  <el-button
                    data-testid="mxc-add-ro"
                    size="small"
                    type="primary"
                    plain
                    :disabled="windowsNodeMxcFolderApplying"
                    @click="addWindowsNodeMxcFolder('ro')"
                  >
                    {{ t("settings.sandboxAddDir") }}
                  </el-button>
                </div>
                <div
                  v-for="dir in windowsNodeMxcFolderDraft.ro"
                  :key="'mxc-ro-' + dir"
                  class="dir-item"
                >
                  <span class="dir-path" :title="dir">{{ dir }}</span>
                  <span class="dir-badge dir-badge-ro">RO</span>
                  <el-button
                    data-testid="mxc-change-rw"
                    text
                    size="small"
                    :disabled="windowsNodeMxcFolderApplying"
                    @click="changeWindowsNodeMxcFolderAccess(dir, 'rw')"
                  >
                    {{ t("settings.windowsNodeMxcChangeToRw") }}
                  </el-button>
                  <button
                    class="tag-remove"
                    :disabled="windowsNodeMxcFolderApplying"
                    @click="removeWindowsNodeMxcFolder(dir, 'ro')"
                  >
                    &times;
                  </button>
                </div>
                <div v-if="windowsNodeMxcFolderDraft.ro.length === 0" class="dir-empty">
                  {{ t("settings.sandboxNoDirs") }}
                </div>
              </div>
              <div v-if="windowsNodeMxcFolderDraftDirty" class="mxc-folder-policy-actions">
                <el-button
                  type="primary"
                  :loading="windowsNodeMxcFolderApplying"
                  data-testid="mxc-apply-folder-policy"
                  @click="applyWindowsNodeMxcFolderPolicy"
                >
                  {{ t("settings.windowsNodeMxcApplyFolders") }}
                </el-button>
                <el-button
                  :disabled="windowsNodeMxcFolderApplying"
                  @click="replaceWindowsNodeMxcFolderDraft(windowsNodeMxcFolderBaseline)"
                >
                  {{ t("common.cancel") }}
                </el-button>
              </div>
            </div>
            <div
              class="card-row no-border mxc-folder-policy"
              style="flex-direction: column; align-items: stretch"
            >
              <div class="mxc-folder-policy-heading">
                <span class="row-label">{{ t("settings.windowsNodeMxcDurableApprovals") }}</span>
                <el-button
                  v-if="windowsNodeMxcStatus.durableApprovals.records.length"
                  size="small"
                  type="danger"
                  plain
                  @click="revokeAllWindowsNodeMxcDurableApprovals"
                >
                  {{ t("settings.windowsNodeMxcRevokeAllApprovals") }}
                </el-button>
              </div>
              <div class="mxc-folder-policy-hint">
                {{ t("settings.windowsNodeMxcDurableApprovalsHint") }}
              </div>
              <div
                v-for="approval in windowsNodeMxcStatus.durableApprovals.records"
                :key="approval.id"
                class="mxc-durable-approval"
              >
                <strong>{{ approval.commandText }}</strong>
                <span>{{ approval.executablePath }}</span>
                <span
                  >{{ t("settings.windowsNodeMxcApprovalCwd") }}: {{ approval.cwdBinding }}</span
                >
                <span>
                  {{ t("settings.windowsNodeMxcApprovalAccess") }}:
                  {{
                    approval.declaredAccess
                      .map((entry) => `${entry.access.toUpperCase()} ${entry.path}`)
                      .join(", ") || "none"
                  }}
                </span>
                <span>
                  {{ t("settings.windowsNodeMxcApprovalScope") }}:
                  {{ approval.agentId ?? "none" }} / {{ approval.sessionKey }}
                </span>
                <span>
                  {{ t("settings.windowsNodeMxcApprovalCreated") }}: {{ approval.createdAt }} ·
                  {{ t("settings.windowsNodeMxcApprovalLastUsed") }}:
                  {{ approval.lastUsedAt ?? t("settings.windowsNodeMxcApprovalNever") }}
                </span>
                <el-button
                  size="small"
                  type="danger"
                  plain
                  @click="revokeWindowsNodeMxcDurableApproval(approval.id)"
                >
                  {{ t("settings.windowsNodeMxcRevokeApproval") }}
                </el-button>
              </div>
              <div
                v-if="windowsNodeMxcStatus.durableApprovals.records.length === 0"
                class="dir-empty"
              >
                {{ t("settings.windowsNodeMxcNoDurableApprovals") }}
              </div>
              <div
                v-if="windowsNodeMxcStatus.durableApprovals.warning"
                class="mxc-alert mxc-alert-warning"
              >
                {{ windowsNodeMxcStatus.durableApprovals.warning }}
              </div>
            </div>
            <button
              type="button"
              class="mxc-technical-summary"
              :aria-expanded="windowsNodeMxcTechnicalDetailsOpen"
              aria-controls="windows-node-mxc-technical-details"
              data-testid="mxc-technical-details-toggle"
              @click="windowsNodeMxcTechnicalDetailsOpen = !windowsNodeMxcTechnicalDetailsOpen"
            >
              <span>{{ t("settings.windowsNodeMxcTechnicalDetails") }}</span>
              <span class="mxc-technical-chevron" aria-hidden="true">
                {{ windowsNodeMxcTechnicalDetailsOpen ? "−" : "+" }}
              </span>
            </button>
            <div
              v-if="windowsNodeMxcTechnicalDetailsOpen"
              id="windows-node-mxc-technical-details"
              class="mxc-technical-details"
              role="region"
              :aria-label="t('settings.windowsNodeMxcTechnicalDetails')"
              data-testid="mxc-technical-details"
            >
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcSelectedNode") }}</span>
                <span class="row-value">
                  {{
                    windowsNodeMxcStatus.selectedNode
                      ? `${windowsNodeMxcStatus.selectedNode.displayName} (${windowsNodeMxcStatus.selectedNode.id})`
                      : t("settings.windowsNodeMxcUnavailable")
                  }}
                </span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcLifecycle") }}</span>
                <span class="row-value">
                  {{
                    t(
                      `settings.windowsNodeMxcLifecyclePhase.${windowsNodeMxcStatus.lifecycleState.phase}`,
                    )
                  }}
                  <template v-if="windowsNodeMxcStatus.lifecycleState.detail">
                    · {{ windowsNodeMxcStatus.lifecycleState.detail }}
                  </template>
                </span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcGatewayPolicy") }}</span>
                <span class="row-value">{{ windowsNodeMxcStatus.gatewayPolicyState }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcTier") }}</span>
                <span class="row-value">
                  {{ windowsNodeMxcStatus.probe.tier ?? windowsNodeMxcStatus.probe.outcome }}
                  <template v-if="windowsNodeMxcStatus.probe.needsDaclAugmentation">
                    · {{ t("settings.windowsNodeMxcDaclRequired") }}
                  </template>
                </span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcBundledHelper") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.helperRevision
                    ? windowsNodeMxcStatus.helperRevision.slice(0, 12)
                    : t("settings.windowsNodeMxcUnavailable")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcRuntimeContract") }}</span>
                <span class="row-value">{{
                  `${windowsNodeMxcStatus.mxcRuntimeVersion ?? t("settings.windowsNodeMxcUnavailable")} / ${
                    windowsNodeMxcStatus.cwdPolicyContract ??
                    t("settings.windowsNodeMxcUnavailable")
                  }`
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcSettingsFingerprint") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.settingsFingerprint ??
                  t("settings.windowsNodeMxcUnavailable")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcActivationLease") }}</span>
                <span class="row-value">
                  {{
                    `${windowsNodeMxcStatus.activationLeaseMode ?? "none"} / ${
                      windowsNodeMxcStatus.activationLeaseContract ??
                      t("settings.windowsNodeMxcUnavailable")
                    }`
                  }}
                </span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcGatewayGeneration") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.gatewayGeneration || t("settings.windowsNodeMxcUnavailable")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcStrictFallback") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.strictFallbackEffective
                    ? t("settings.windowsNodeMxcEnabled")
                    : t("settings.windowsNodeMxcDisabled")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcCwdAttestation") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.cwdAttestationReady
                    ? t("settings.windowsNodeMxcVerified")
                    : t("settings.windowsNodeMxcUnverified")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcEffectiveTools") }}</span>
                <span class="row-value">{{ windowsNodeMxcStatus.effectiveToolsState }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcCommands") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.selectedNode?.commands.join(", ") || "—"
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcConnection") }}</span>
                <span class="row-value">
                  {{
                    windowsNodeMxcStatus.selectedNode
                      ? `${windowsNodeMxcStatus.selectedNode.connected ? "connected" : "disconnected"} / ${
                          windowsNodeMxcStatus.selectedNode.paired
                            ? "paired"
                            : "reapproval required"
                        }`
                      : "not selected"
                  }}
                </span>
              </div>
              <div class="card-row no-border">
                <span class="row-label">{{ t("settings.windowsNodeMxcSmoke") }}</span>
                <span class="row-value">
                  {{
                    windowsNodeMxcStatus.smoke
                      ? `${windowsNodeMxcStatus.smoke.deniedOutsideRoot.outcome} / ${windowsNodeMxcStatus.smoke.hostname.outcome} / ${windowsNodeMxcStatus.smoke.powershell.outcome}`
                      : t("settings.windowsNodeMxcNotRun")
                  }}
                </span>
              </div>
            </div>
          </template>
        </div>
        <div class="section-footer">{{ t("settings.windowsNodeMxcCompatibility") }}</div>

        <div v-if="windowsNodeMxcStatus?.probe.degraded" class="mxc-alert mxc-alert-warning">
          {{ t("settings.windowsNodeMxcDegraded") }}
        </div>
        <div
          v-for="blocker in windowsNodeMxcStatus?.blockers ?? []"
          :key="`blocker-${blocker}`"
          class="mxc-alert mxc-alert-error"
        >
          {{ blocker }}
        </div>
        <div
          v-for="warning in windowsNodeMxcStatus?.warnings ?? []"
          :key="`warning-${warning}`"
          class="mxc-alert mxc-alert-warning"
        >
          {{ warning }}
        </div>
        <div
          v-for="step in windowsNodeMxcStatus?.remediation ?? []"
          :key="`remediation-${step}`"
          class="mxc-alert"
        >
          {{ step }}
        </div>

        <div
          v-if="!windowsNodeMxcStatus?.desiredEnabled"
          class="card-group"
          style="margin-top: 12px"
        >
          <div class="card-row">
            <span class="row-label">{{ t("settings.sandboxEnabled") }}</span>
            <div style="display: flex; align-items: center; gap: 10px">
              <span v-if="sandboxRestarting" class="restart-hint">{{
                t("settings.sandboxCapsRestarting")
              }}</span>
              <el-switch
                v-model="sandboxStatus.enabled"
                :disabled="sandboxRestarting"
                @change="toggleSandbox"
              />
            </div>
          </div>
        </div>

        <div
          v-if="!windowsNodeMxcStatus?.desiredEnabled"
          :class="{ 'sandbox-disabled': !sandboxStatus.enabled }"
        >
          <!-- Sandbox capabilities (network) -->
          <div class="card-group" style="margin-top: 12px">
            <div class="card-row">
              <span class="row-label">{{ t("settings.cap.internetClient") }}</span>
              <div style="display: flex; align-items: center; gap: 10px">
                <span v-if="capsRestarting" class="restart-hint">{{
                  t("settings.sandboxCapsRestarting")
                }}</span>
                <el-switch
                  :model-value="sandboxCapabilities.includes('internetClient')"
                  :disabled="capsRestarting"
                  @change="(v: boolean) => toggleCapability('internetClient', v)"
                />
              </div>
            </div>
          </div>
          <div class="section-footer">{{ t("settings.sandboxCapsHint") }}</div>

          <!-- External apps whitelist -->
          <div class="card-group" style="margin-top: 12px">
            <div class="card-row no-border" style="flex-direction: column; align-items: stretch">
              <div
                style="
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  margin-bottom: 8px;
                "
              >
                <span class="row-label" style="margin: 0">{{ t("settings.externalApps") }}</span>
              </div>
              <div class="external-apps-list">
                <div v-for="(app, idx) in externalApps" :key="idx" class="app-tag">
                  <span>{{ app }}</span>
                  <button class="tag-remove" @click="removeExternalApp(idx)">&times;</button>
                </div>
                <div class="app-tag app-tag-add">
                  <input
                    v-model="newAppName"
                    class="app-add-input"
                    :placeholder="t('settings.addApp')"
                    @keyup.enter="addExternalApp"
                  />
                  <button class="tag-add-btn" @click="addExternalApp">+</button>
                </div>
              </div>
            </div>
          </div>
          <div class="section-footer">{{ t("settings.externalAppsHint") }}</div>

          <!-- Sandbox directory permissions -->
          <div class="card-group" style="margin-top: 12px">
            <div class="card-row no-border" style="flex-direction: column; align-items: stretch">
              <div
                style="
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  margin-bottom: 8px;
                "
              >
                <span
                  class="row-label"
                  style="margin: 0; cursor: default; user-select: none"
                  @click="onSandboxDirsLabelClick"
                  >{{ t("settings.sandboxDirs") }}</span
                >
              </div>
              <!-- Read-Write directories -->
              <div class="dir-section">
                <div
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 6px;
                  "
                >
                  <span class="dir-section-label">{{ t("settings.sandboxDirsRW") }}</span>
                  <el-button
                    data-testid="sandbox-add-rw"
                    size="small"
                    type="primary"
                    plain
                    @click="addSandboxDir('rw')"
                  >
                    {{ t("settings.sandboxAddDir") }}
                  </el-button>
                </div>
                <div
                  v-for="(dir, idx) in sandboxSystemDirs.rw"
                  :key="'srw-' + idx"
                  class="dir-item dir-item-system"
                >
                  <span class="dir-path" :title="dir">{{ dir }}</span>
                  <span class="dir-badge dir-badge-rw">RW</span>
                  <span class="dir-badge dir-badge-system">{{
                    t("settings.sandboxSystemDir")
                  }}</span>
                </div>
                <div v-for="dir in sandboxUserDirs.rw" :key="'rw-' + dir" class="dir-item">
                  <span class="dir-path" :title="dir">{{ dir }}</span>
                  <span class="dir-badge dir-badge-rw">RW</span>
                  <button class="tag-remove" @click="removeSandboxDir(dir, 'rw')">&times;</button>
                </div>
                <div
                  v-if="sandboxSystemDirs.rw.length === 0 && sandboxUserDirs.rw.length === 0"
                  class="dir-empty"
                >
                  {{ t("settings.sandboxNoDirs") }}
                </div>
              </div>

              <!-- Read-Only directories -->
              <div class="dir-section" style="margin-top: 10px">
                <div
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 6px;
                  "
                >
                  <span class="dir-section-label">{{ t("settings.sandboxDirsRO") }}</span>
                  <el-button
                    data-testid="sandbox-add-ro"
                    size="small"
                    type="primary"
                    plain
                    @click="addSandboxDir('ro')"
                  >
                    {{ t("settings.sandboxAddDir") }}
                  </el-button>
                </div>
                <div
                  v-for="(dir, idx) in sandboxSystemDirs.ro"
                  :key="'sro-' + idx"
                  class="dir-item dir-item-system"
                >
                  <span class="dir-path" :title="dir">{{ dir }}</span>
                  <span class="dir-badge dir-badge-ro">RO</span>
                  <span class="dir-badge dir-badge-system">{{
                    t("settings.sandboxSystemDir")
                  }}</span>
                </div>
                <div v-for="dir in sandboxUserDirs.ro" :key="'ro-' + dir" class="dir-item">
                  <span class="dir-path" :title="dir">{{ dir }}</span>
                  <span class="dir-badge dir-badge-ro">RO</span>
                  <button class="tag-remove" @click="removeSandboxDir(dir, 'ro')">&times;</button>
                </div>
                <div
                  v-if="sandboxSystemDirs.ro.length === 0 && sandboxUserDirs.ro.length === 0"
                  class="dir-empty"
                >
                  {{ t("settings.sandboxNoDirs") }}
                </div>
              </div>

              <!-- ACL Verify Button (dev/testing tool, triple-click to show) -->
              <div
                v-if="showAclVerify"
                class="dir-section"
                style="
                  margin-top: 14px;
                  border-top: 1px solid var(--border-color);
                  padding-top: 12px;
                "
              >
                <div
                  style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 8px;
                  "
                >
                  <span class="dir-section-label">🔍 ACL 验证</span>
                  <button class="dir-add-btn" :disabled="aclVerifying" @click="verifyAcls">
                    {{ aclVerifying ? "扫描中..." : "验证权限一致性" }}
                  </button>
                </div>
                <div v-if="aclVerifyResult" class="acl-verify-results">
                  <!-- OK -->
                  <div v-if="aclVerifyResult.ok.length > 0" class="acl-section">
                    <div class="acl-section-header acl-ok">
                      ✓ 正常 ({{ aclVerifyResult.ok.length }})
                    </div>
                    <div
                      v-for="item in aclVerifyResult.ok"
                      :key="'ok-' + item.dir"
                      class="dir-item dir-item-system"
                    >
                      <span class="dir-path" :title="item.dir">{{ item.dir }}</span>
                      <span
                        class="dir-badge"
                        :class="item.access === 'rw' ? 'dir-badge-rw' : 'dir-badge-ro'"
                        >{{ item.access.toUpperCase() }}</span
                      >
                    </div>
                  </div>
                  <!-- Missing -->
                  <div v-if="aclVerifyResult.missing.length > 0" class="acl-section">
                    <div class="acl-section-header acl-warn">
                      ⚠ 缺少 ACL ({{ aclVerifyResult.missing.length }})
                    </div>
                    <div
                      v-for="item in aclVerifyResult.missing"
                      :key="'miss-' + item.dir"
                      class="dir-item"
                    >
                      <span class="dir-path" :title="item.dir">{{ item.dir }}</span>
                      <span class="dir-badge dir-badge-ro">{{ item.access.toUpperCase() }}</span>
                      <span class="acl-reason">{{ item.reason }}</span>
                      <button
                        class="dir-add-btn"
                        style="margin-left: auto"
                        @click="repairAcl(item)"
                      >
                        修复
                      </button>
                    </div>
                  </div>
                  <!-- Stale -->
                  <div v-if="aclVerifyResult.stale.length > 0" class="acl-section">
                    <div class="acl-section-header acl-warn">
                      🗑 残留 ACL ({{ aclVerifyResult.stale.length }})
                    </div>
                    <div
                      v-for="item in aclVerifyResult.stale"
                      :key="'stale-' + item.dir"
                      class="dir-item"
                    >
                      <span class="dir-path" :title="item.dir">{{ item.dir }}</span>
                      <span class="dir-badge dir-badge-system">{{ item.rights }}</span>
                      <button
                        class="dir-add-btn"
                        style="margin-left: auto"
                        @click="revokeStaleAcl(item)"
                      >
                        清除
                      </button>
                    </div>
                  </div>
                  <!-- Errors -->
                  <div v-if="aclVerifyResult.errors.length > 0" class="acl-section">
                    <div class="acl-section-header acl-err">
                      ✗ 错误 ({{ aclVerifyResult.errors.length }})
                    </div>
                    <div
                      v-for="item in aclVerifyResult.errors"
                      :key="'err-' + item.dir"
                      class="dir-item"
                    >
                      <span class="dir-path" :title="item.dir">{{ item.dir }}</span>
                      <span class="acl-reason">{{ item.error }}</span>
                    </div>
                  </div>
                  <!-- Summary -->
                  <div
                    v-if="
                      aclVerifyResult.missing.length === 0 &&
                      aclVerifyResult.stale.length === 0 &&
                      aclVerifyResult.errors.length === 0
                    "
                    class="acl-summary-ok"
                  >
                    ✓ 所有权限均已正确设置
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="section-footer">{{ t("settings.sandboxDirsHint") }}</div>
        </div>
        <!-- .sandbox-disabled wrapper -->
      </div>

      <!-- Data & Privacy -->
      <div v-if="activeSection === 'privacy'" class="section">
        <!-- Privacy Protection Level -->
        <div class="section-label">{{ t("settings.privacyProtection") }}</div>
        <div class="privacy-levels">
          <div
            class="privacy-card"
            :class="{ active: settings.privacyLevel === 'basic' }"
            @click="setPrivacyLevel('basic')"
          >
            <div class="privacy-card-header">
              <span class="privacy-card-icon">🛡️</span>
              <span class="privacy-card-title">{{ t("settings.privacyBasic") }}</span>
            </div>
            <ul class="privacy-card-list">
              <li>{{ t("settings.privacyBasicDesc1") }}</li>
              <li>{{ t("settings.privacyBasicDesc2") }}</li>
            </ul>
          </div>
          <div
            class="privacy-card"
            :class="{ active: settings.privacyLevel === 'strict' }"
            @click="setPrivacyLevel('strict')"
          >
            <div class="privacy-card-header">
              <span class="privacy-card-icon">🔒</span>
              <span class="privacy-card-title">{{ t("settings.privacyStrict") }}</span>
            </div>
            <ul class="privacy-card-list">
              <li>{{ t("settings.privacyStrictDesc1") }}</li>
              <li>{{ t("settings.privacyStrictDesc2") }}</li>
            </ul>
          </div>
        </div>
        <div class="section-footer">{{ t("settings.privacyProtectionDesc") }}</div>

        <!-- PII Detection -->
        <div class="sub-label">{{ t("settings.piiDetection") }}</div>
        <div class="card-group">
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiPhone") }}</span>
            <el-switch
              v-model="piiToggles.phone"
              :disabled="settings.privacyLevel === 'basic'"
              @change="persistPrivacyControls"
            />
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiIdCard") }}</span>
            <el-switch
              v-model="piiToggles.idCard"
              :disabled="settings.privacyLevel === 'basic'"
              @change="persistPrivacyControls"
            />
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiBankCard") }}</span>
            <el-switch
              v-model="piiToggles.bankCard"
              :disabled="settings.privacyLevel === 'basic'"
              @change="persistPrivacyControls"
            />
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiEmail") }}</span>
            <el-switch
              v-model="piiToggles.email"
              :disabled="settings.privacyLevel === 'basic'"
              @change="persistPrivacyControls"
            />
          </div>
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.piiApiKey") }}</span>
            <el-switch
              v-model="piiToggles.apiKey"
              :disabled="settings.privacyLevel === 'basic'"
              @change="persistPrivacyControls"
            />
          </div>
        </div>
        <div class="section-footer">{{ t("settings.piiDetectionDesc") }}</div>

        <!-- Sensitive File Guard -->
        <div class="sub-label">{{ t("settings.sensitiveFiles") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <div class="sensitive-file-info">
              <span class="sensitive-file-examples">{{ t("settings.sensitiveFilePatterns") }}</span>
            </div>
            <span class="status-indicator status-indicator--warn">
              <span class="status-dot"></span>
              {{ t("settings.permissionRequired") }}
            </span>
          </div>
        </div>
        <div class="section-footer">{{ t("settings.sensitiveFilesDesc") }}</div>

        <!-- Chat History (existing) -->
        <div class="sub-label">{{ t("settings.chatHistory") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.savedChatHistory") }}</span>
            <el-button type="danger" plain size="small" @click="clearChatHistory">{{
              t("settings.clearAllHistory")
            }}</el-button>
          </div>
        </div>
      </div>

      <!-- About -->
      <div v-if="activeSection === 'about'" class="section about-section">
        <div class="section-label">{{ t("settings.about") }}</div>
        <div class="about-main">
          <div class="about-card">
            <div class="about-card-content">
              <img class="about-icon" :src="microclawLogo" alt="MicroClaw" />
              <div class="about-name">{{ t("app.name") }}</div>
              <div class="about-version">{{ t("settings.version") }}</div>
              <el-button
                type="primary"
                plain
                size="small"
                :loading="updateChecking"
                class="update-check-btn"
                @click="checkForUpdates"
              >
                {{ updateChecking ? t("settings.updateChecking") : t("settings.checkForUpdates") }}
              </el-button>
            </div>
            <p class="copyright-notice">Copyright © 2026 {{ t("app.name") }}</p>
          </div>
          <div v-if="updateResult" class="update-card" :class="`update-card-${updateResult.status}`">
            <div class="update-title">{{ updateStatusTitle }}</div>
            <div class="update-detail">{{ updateStatusDetail }}</div>
            <ul
              v-if="updateResult.status === 'update-available' && updateResult.releaseNotes.length"
              class="update-notes"
            >
              <li v-for="note in updateResult.releaseNotes" :key="note">{{ note }}</li>
            </ul>
            <el-button
              v-if="updateResult.status === 'update-available'"
              type="primary"
              size="small"
              class="update-download-btn"
              @click="openUpdateDownload"
            >
              {{ t("settings.downloadUpdate") }}
            </el-button>
          </div>
        </div>
      </div>

      <ModelSetupDialog
        v-model="showProviderSetup"
        single-provider
        @configured="handleProviderConfigured"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, watch, computed, defineAsyncComponent } from "vue";
import { useRoute } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { ElMessage, ElMessageBox } from "element-plus";
import ChannelsView from "@/views/ChannelsView.vue";
import microclawLogo from "../../../assets/microclaw.png";
import { t, setLocale } from "@/i18n";
import type { Locale } from "@/i18n";
import ModelSetupDialog from "@/components/ModelSetupDialog.vue";
import {
  normalizeModelInput,
  removeModelProviderConfig,
  selectPrimaryModelConfig,
  retainOnlyProvider,
  type ModelApiFormat,
  type ModelInputCapability,
  type ModelReasoningEffort,
} from "@/utils/model-provider";
import {
  mergeGitHubCopilotModelEntries,
  removeGitHubCopilotModelReferences,
} from "@/utils/auth-managed-models";
import { getManagedModelProvider } from "@/utils/managed-model-providers";
import {
  hydratePrivacyControls,
  type PrivacyControls,
  type PrivacyLevel,
} from "@/utils/privacy-settings";
const route = useRoute();
const gateway = useGatewayStore();
const chatStore = useChatStore();
const devSettingsEnabled =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_SETTINGS === "true";
const SkillsDevPanel = devSettingsEnabled
  ? defineAsyncComponent(() => import("@/components/skills/SkillsDevPanel.vue"))
  : null;

const activeSection = ref("general");
const exportingGatewayLogs = ref(false);
const updateChecking = ref(false);
const updateResult = ref<UpdateCheckResult | null>(null);

const updateStatusTitle = computed(() => {
  if (!updateResult.value) return "";
  if (updateResult.value.status === "update-available") {
    return t("settings.updateAvailable", { version: updateResult.value.latestVersion });
  }
  if (updateResult.value.status === "up-to-date") {
    return t("settings.updateUpToDate");
  }
  if (updateResult.value.status === "managed-by-store") {
    return t("settings.updateManagedByStore");
  }
  return t("settings.updateCheckFailed");
});

const updateStatusDetail = computed(() => {
  if (!updateResult.value) return "";
  if (updateResult.value.status === "update-available") {
    return t("settings.updateAvailableDetail", {
      current: updateResult.value.currentVersion,
      latest: updateResult.value.latestVersion,
    });
  }
  if (updateResult.value.status === "up-to-date") {
    return t("settings.updateUpToDateDetail", { version: updateResult.value.currentVersion });
  }
  if (updateResult.value.status === "managed-by-store") {
    return t("settings.updateManagedByStoreDetail");
  }
  return updateResult.value.message;
});

const VALID_SECTIONS = [
  "general",
  "usage",
  "models",
  "channels",
  ...(devSettingsEnabled ? ["skills"] : []),
  "security",
  "privacy",
  "about",
];

function normalizeSection(section: unknown) {
  if (section === "theme") return "general";
  if (section === "workspace") return "general";
  return typeof section === "string" && VALID_SECTIONS.includes(section) ? section : null;
}

// Initialise activeSection from the route param (e.g. /settings/models)
const initialSection = normalizeSection(route.params.section);
if (initialSection) {
  activeSection.value = initialSection;
}

// React to route-param changes while this view is mounted (e.g. user clicks
// "Open Model Settings" from the chat error panel while already on /settings).
watch(
  () => route.params.section,
  (section) => {
    const normalizedSection = normalizeSection(section);
    if (normalizedSection) {
      activeSection.value = normalizedSection;
    }
  },
);

// -- Sandbox state --
const sandboxStatus = reactive({ available: false, enabled: false });
const externalApps = ref<string[]>([]);
const newAppName = ref("");
const sandboxNeedsRestart = ref(false);
const sandboxApplying = ref(false);
/** Snapshot of external apps at load time, used to detect changes */
let externalAppsOriginal: string[] = [];
const sandboxUserDirs = reactive<{ rw: string[]; ro: string[] }>({ rw: [], ro: [] });
const windowsNodeMxcFolderDraft = reactive<{ rw: string[]; ro: string[] }>({ rw: [], ro: [] });
const windowsNodeMxcFolderBaseline = reactive<{ rw: string[]; ro: string[] }>({ rw: [], ro: [] });
const sandboxSystemDirs = reactive<{ rw: string[]; ro: string[] }>({ rw: [], ro: [] });
const sandboxCapabilities = ref<string[]>([]);
const capsRestarting = ref(false);
const sandboxRestarting = ref(false);
type WindowsNodeMxcStatus = Awaited<ReturnType<typeof window.openclaw.windowsNodeMxc.getStatus>>;
const windowsNodeMxcStatus = ref<WindowsNodeMxcStatus | null>(null);
const windowsNodeMxcApplying = ref(false);
const windowsNodeMxcFolderApplying = ref(false);
const windowsNodeMxcTechnicalDetailsOpen = ref(false);
const windowsNodeMxcTransitionPhases = new Set([
  "locking",
  "validating",
  "persisting",
  "starting-locked",
  "smoking-locked",
  "starting-active",
  "smoking-active",
  "verifying-active",
  "starting-standard",
]);

const windowsNodeMxcProtectionLabel = computed(() => {
  const status = windowsNodeMxcStatus.value;
  if (!status?.desiredEnabled) return t("settings.windowsNodeMxcProtectionOff");
  if (status.effectiveEnabled && status.lifecycleState.phase === "active") {
    return t("settings.windowsNodeMxcProtected");
  }
  if (windowsNodeMxcTransitionPhases.has(status.lifecycleState.phase)) {
    return t("settings.windowsNodeMxcStarting");
  }
  return t("settings.windowsNodeMxcActionRequired");
});

const windowsNodeMxcProtectionClass = computed(() => {
  const status = windowsNodeMxcStatus.value;
  if (status?.effectiveEnabled && status.lifecycleState.phase === "active") {
    return "mxc-state-ok";
  }
  return status?.desiredEnabled ? "mxc-state-blocked" : "mxc-state-neutral";
});

const windowsNodeMxcProtectionDetail = computed(() => {
  const status = windowsNodeMxcStatus.value;
  if (
    !status?.desiredEnabled ||
    (status.effectiveEnabled && status.lifecycleState.phase === "active")
  ) {
    return "";
  }
  const phase = t(`settings.windowsNodeMxcLifecyclePhase.${status.lifecycleState.phase}`);
  return status.lifecycleState.detail ? `${phase} · ${status.lifecycleState.detail}` : phase;
});

const windowsNodeMxcFolderDraftDirty = computed(
  () => policyIdentity(windowsNodeMxcFolderDraft) !== policyIdentity(windowsNodeMxcFolderBaseline),
);

function policyIdentity(policy: { rw: string[]; ro: string[] }) {
  const normalize = (values: string[]) =>
    values
      .map((value) => value.toLowerCase())
      .sort()
      .join("\n");
  return `${normalize(policy.rw)}\u0000${normalize(policy.ro)}`;
}

function replaceWindowsNodeMxcFolderDraft(policy: { rw: string[]; ro: string[] }) {
  windowsNodeMxcFolderDraft.rw.splice(0, windowsNodeMxcFolderDraft.rw.length, ...policy.rw);
  windowsNodeMxcFolderDraft.ro.splice(0, windowsNodeMxcFolderDraft.ro.length, ...policy.ro);
}

function replaceWindowsNodeMxcFolderBaseline(policy: { rw: string[]; ro: string[] }) {
  windowsNodeMxcFolderBaseline.rw.splice(0, windowsNodeMxcFolderBaseline.rw.length, ...policy.rw);
  windowsNodeMxcFolderBaseline.ro.splice(0, windowsNodeMxcFolderBaseline.ro.length, ...policy.ro);
}

function updateWindowsNodeMxcStatus(status: WindowsNodeMxcStatus) {
  windowsNodeMxcStatus.value = status;
  const effectiveFolders = {
    rw: status.folders.filter((entry) => entry.access === "rw").map((entry) => entry.path),
    ro: status.folders.filter((entry) => entry.access === "ro").map((entry) => entry.path),
  };
  if (!windowsNodeMxcFolderDraftDirty.value || windowsNodeMxcFolderApplying.value) {
    replaceWindowsNodeMxcFolderDraft(effectiveFolders);
  }
  replaceWindowsNodeMxcFolderBaseline(effectiveFolders);
}

async function loadWindowsNodeMxcStatus() {
  try {
    const status = await window.openclaw.windowsNodeMxc.getStatus();
    updateWindowsNodeMxcStatus(status);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function toggleWindowsNodeMxc(enabled: boolean) {
  windowsNodeMxcApplying.value = true;
  gateway.resetReady();
  chatStore.wsConnected = false;
  try {
    const status = await window.openclaw.windowsNodeMxc.setEnabled({ enabled });
    updateWindowsNodeMxcStatus(status);
    await loadSandboxStatus();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
    await loadWindowsNodeMxcStatus();
  } finally {
    windowsNodeMxcApplying.value = false;
  }
}

async function loadSandboxStatus() {
  try {
    const status = await window.openclaw.sandbox.getStatus();
    sandboxStatus.available = status.available;
    sandboxStatus.enabled = status.enabled;
    externalApps.value = await window.openclaw.sandbox.getExternalApps();
    externalAppsOriginal = [...externalApps.value];
    sandboxNeedsRestart.value = false;
    sandboxCapabilities.value = await window.openclaw.sandbox.getCapabilities();
    const dirs = await window.openclaw.sandbox.getUserDirs();
    sandboxUserDirs.rw = dirs.rw;
    sandboxUserDirs.ro = dirs.ro;
    // System dirs = all dirs from sandbox status minus user-added dirs
    const userRwSet = new Set(dirs.rw.map((d: string) => d.toLowerCase()));
    const userRoSet = new Set(dirs.ro.map((d: string) => d.toLowerCase()));
    sandboxSystemDirs.rw = (status.sandboxDirsRW || []).filter(
      (d: string) => !userRwSet.has(d.toLowerCase()),
    );
    sandboxSystemDirs.ro = (status.sandboxDirsRO || []).filter(
      (d: string) => !userRoSet.has(d.toLowerCase()),
    );
  } catch {}
}

async function toggleSandbox(enabled: boolean) {
  sandboxRestarting.value = true;
  await window.openclaw.sandbox.setEnabled(enabled);
  // Wait for reconnection
  const deadline = Date.now() + 15000;
  const poll = setInterval(async () => {
    try {
      if ((await window.openclaw.chat.isConnected()) || Date.now() > deadline) {
        clearInterval(poll);
        sandboxRestarting.value = false;
        await loadSandboxStatus();
      }
    } catch {
      clearInterval(poll);
      sandboxRestarting.value = false;
    }
  }, 500);
}

function checkDirty() {
  const a = externalApps.value;
  const b = externalAppsOriginal;
  sandboxNeedsRestart.value = a.length !== b.length || a.some((v, i) => v !== b[i]);
}

async function addExternalApp() {
  const name = newAppName.value
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, "");
  if (!name || !/^[a-z0-9_-]+$/.test(name)) return;
  if (externalApps.value.includes(name)) {
    newAppName.value = "";
    return;
  }
  externalApps.value.push(name);
  newAppName.value = "";
  await window.openclaw.sandbox.setExternalApps([...externalApps.value]);
  checkDirty();
}

async function removeExternalApp(idx: number) {
  externalApps.value.splice(idx, 1);
  await window.openclaw.sandbox.setExternalApps([...externalApps.value]);
  checkDirty();
}

async function toggleCapability(cap: string, enabled: boolean) {
  if (enabled) {
    if (!sandboxCapabilities.value.includes(cap)) sandboxCapabilities.value.push(cap);
  } else {
    sandboxCapabilities.value = sandboxCapabilities.value.filter((c) => c !== cap);
  }
  await window.openclaw.sandbox.setCapabilities([...sandboxCapabilities.value]);
  // Auto-restart gateway (capabilities require process restart)
  capsRestarting.value = true;
  try {
    await window.openclaw.gateway.restart();
  } catch {}
  // Wait for reconnection, then clear the hint
  const deadline = Date.now() + 15000;
  const poll = setInterval(async () => {
    try {
      if ((await window.openclaw.chat.isConnected()) || Date.now() > deadline) {
        clearInterval(poll);
        capsRestarting.value = false;
      }
    } catch {
      clearInterval(poll);
      capsRestarting.value = false;
    }
  }, 500);
}

async function _applyExternalApps() {
  sandboxApplying.value = true;
  try {
    await window.openclaw.sandbox.applyExternalApps();
    externalAppsOriginal = [...externalApps.value];
    sandboxNeedsRestart.value = false;
  } finally {
    sandboxApplying.value = false;
  }
}

async function addSandboxDir(access: "rw" | "ro", policy?: "windows-node-mxc") {
  const result = await window.openclaw.sandbox.addUserDir({
    access,
    ...(policy ? { policy } : {}),
  });
  if (result.reason === "parent-covers") {
    const accessLabel =
      result.parentAccess === "rw" ? t("settings.sandboxDirsRW") : t("settings.sandboxDirsRO");
    ElMessage.warning(
      t("settings.sandboxParentCovers", { parentDir: result.parentDir || "", access: accessLabel }),
    );
    return;
  }
  if (result.reason === "parent-rw-covers") {
    ElMessage.warning(t("settings.sandboxParentRWCovers", { parentDir: result.parentDir || "" }));
    return;
  }
  if (result.reason && policy === "windows-node-mxc") {
    showWindowsNodeMxcFolderPolicyError(result.reason);
    return;
  }
  if (result.ok) {
    sandboxUserDirs.rw = result.dirs.rw;
    sandboxUserDirs.ro = result.dirs.ro;
    if (result.removedChildren && result.removedChildren.length > 0) {
      ElMessage.info(
        t("settings.sandboxChildrenRemoved", { count: result.removedChildren.length }),
      );
    }
  }
}

function showWindowsNodeMxcFolderPolicyError(reason: string) {
  const keyByReason: Record<string, string> = {
    duplicate: "settings.windowsNodeMxcFolderDuplicate",
    "path-nonlocal": "settings.windowsNodeMxcFolderNonlocal",
    "path-not-found": "settings.windowsNodeMxcFolderMissing",
    "path-reparse-point": "settings.windowsNodeMxcFolderReparse",
    "path-sensitive": "settings.windowsNodeMxcFolderSensitive",
    "acl-failed": "settings.windowsNodeMxcFolderAclFailed",
    "folder-not-configured": "settings.windowsNodeMxcFolderNotConfigured",
  };
  ElMessage.error(t(keyByReason[reason] ?? "settings.windowsNodeMxcFolderMutationFailed"));
}

async function addWindowsNodeMxcFolder(access: "rw" | "ro") {
  try {
    if (!windowsNodeMxcStatus.value?.desiredEnabled) {
      await addSandboxDir(access, "windows-node-mxc");
      await loadWindowsNodeMxcStatus();
      return;
    }
    const result = await window.openclaw.sandbox.stageUserDir({
      access,
      draft: {
        rw: [...windowsNodeMxcFolderDraft.rw],
        ro: [...windowsNodeMxcFolderDraft.ro],
      },
    });
    if (result.canceled) return;
    if (!result.ok) {
      showWindowsNodeMxcFolderPolicyError(result.reason ?? "");
      return;
    }
    replaceWindowsNodeMxcFolderDraft(result.dirs);
    if (result.removedChildren?.length) {
      ElMessage.info(
        t("settings.sandboxChildrenRemoved", { count: result.removedChildren.length }),
      );
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function changeWindowsNodeMxcFolderAccess(dir: string, access: "rw" | "ro") {
  try {
    if (!windowsNodeMxcStatus.value?.desiredEnabled) {
      const result = await window.openclaw.sandbox.setUserDirAccess({ dir, access });
      if (!result.ok) showWindowsNodeMxcFolderPolicyError(result.reason ?? "");
      await Promise.all([loadSandboxStatus(), loadWindowsNodeMxcStatus()]);
      return;
    }
    const next = {
      rw: windowsNodeMxcFolderDraft.rw.filter((entry) => entry !== dir),
      ro: windowsNodeMxcFolderDraft.ro.filter((entry) => entry !== dir),
    };
    next[access].push(dir);
    replaceWindowsNodeMxcFolderDraft(
      await window.openclaw.windowsNodeMxc.validateFolderPolicy(next),
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function removeWindowsNodeMxcFolder(dir: string, access: "rw" | "ro") {
  try {
    if (!windowsNodeMxcStatus.value?.desiredEnabled) {
      await removeSandboxDir(dir, access);
      await loadWindowsNodeMxcStatus();
      return;
    }
    const next = {
      rw: [...windowsNodeMxcFolderDraft.rw],
      ro: [...windowsNodeMxcFolderDraft.ro],
    };
    next[access] = next[access].filter((entry) => entry !== dir);
    replaceWindowsNodeMxcFolderDraft(
      await window.openclaw.windowsNodeMxc.validateFolderPolicy(next),
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function applyWindowsNodeMxcFolderPolicy() {
  try {
    await ElMessageBox.confirm(
      t("settings.windowsNodeMxcApplyFoldersWarning"),
      t("settings.windowsNodeMxcApplyFolders"),
      {
        type: "warning",
        confirmButtonText: t("settings.windowsNodeMxcApplyFolders"),
        cancelButtonText: t("common.cancel"),
      },
    );
  } catch {
    return;
  }
  windowsNodeMxcFolderApplying.value = true;
  try {
    const status = await window.openclaw.windowsNodeMxc.applyFolderPolicy({
      rw: [...windowsNodeMxcFolderDraft.rw],
      ro: [...windowsNodeMxcFolderDraft.ro],
    });
    updateWindowsNodeMxcStatus(status);
    await loadSandboxStatus();
    ElMessage.success(t("settings.windowsNodeMxcApplyFoldersComplete"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
    await loadWindowsNodeMxcStatus();
  } finally {
    windowsNodeMxcFolderApplying.value = false;
  }
}

function stagePreviousWindowsNodeMxcFolderPolicy() {
  const previous = windowsNodeMxcStatus.value?.folderPolicyRecovery?.previous;
  if (previous) replaceWindowsNodeMxcFolderDraft(previous);
}

async function revokeWindowsNodeMxcDurableApproval(id: string) {
  try {
    await window.openclaw.windowsNodeMxc.revokeDurableApproval(id);
    await loadWindowsNodeMxcStatus();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function revokeAllWindowsNodeMxcDurableApprovals() {
  try {
    await ElMessageBox.confirm(
      t("settings.windowsNodeMxcRevokeAllApprovalsWarning"),
      t("settings.windowsNodeMxcRevokeAllApprovals"),
      {
        type: "warning",
        confirmButtonText: t("settings.windowsNodeMxcRevokeAllApprovals"),
        cancelButtonText: t("common.cancel"),
      },
    );
  } catch {
    return;
  }
  await window.openclaw.windowsNodeMxc.revokeAllDurableApprovals();
  await loadWindowsNodeMxcStatus();
}

async function removeSandboxDir(dir: string, access: "rw" | "ro") {
  // Optimistic UI — remove immediately so the user sees instant feedback
  const listKey = access === "rw" ? "rw" : "ro";
  const idx = sandboxUserDirs[listKey].indexOf(dir);
  if (idx >= 0) sandboxUserDirs[listKey].splice(idx, 1);

  const result = await window.openclaw.sandbox.removeUserDir({ dir, access });
  // Sync with actual backend state (adds back if revoke failed)
  sandboxUserDirs.rw.splice(0, sandboxUserDirs.rw.length, ...result.dirs.rw);
  sandboxUserDirs.ro.splice(0, sandboxUserDirs.ro.length, ...result.dirs.ro);
}

// -- ACL Verification (dev tool, triple-click "Sandbox Dirs" label to reveal) --
const showAclVerify = ref(false);
const aclVerifying = ref(false);
const aclVerifyResult = ref<{
  missing: Array<{ dir: string; access: string; reason: string }>;
  stale: Array<{ dir: string; rights: string }>;
  ok: Array<{ dir: string; access: string }>;
  errors: Array<{ dir: string; error: string }>;
} | null>(null);
let _aclTripleClickCount = 0;
let _aclTripleClickTimer: ReturnType<typeof setTimeout> | null = null;

function onSandboxDirsLabelClick() {
  _aclTripleClickCount++;
  if (_aclTripleClickTimer) clearTimeout(_aclTripleClickTimer);
  _aclTripleClickTimer = setTimeout(() => {
    _aclTripleClickCount = 0;
  }, 500);
  if (_aclTripleClickCount >= 3) {
    showAclVerify.value = !showAclVerify.value;
    _aclTripleClickCount = 0;
  }
}

async function verifyAcls() {
  aclVerifying.value = true;
  aclVerifyResult.value = null;
  try {
    aclVerifyResult.value = await window.openclaw.sandbox.verifyAcls();
  } catch (e: any) {
    aclVerifyResult.value = {
      missing: [],
      stale: [],
      ok: [],
      errors: [{ dir: "(scan)", error: e.message }],
    };
  } finally {
    aclVerifying.value = false;
  }
}

async function repairAcl(item: { dir: string; access: string }) {
  const access = item.access === "rw" ? "rw" : ("ro" as const);
  const result = await window.openclaw.sandbox.repairAcl({ dir: item.dir, access });
  if (result.ok) await verifyAcls();
}

async function revokeStaleAcl(item: { dir: string }) {
  const result = await window.openclaw.sandbox.revokeStaleAcl(item.dir);
  if (result.ok) await verifyAcls();
}

const settings = reactive({
  language: "en-US",
  autoStart: false,
  minimizeToTray: false,
  themeMode: "light",
  privacyLevel: "basic" as PrivacyLevel,
});

const piiToggles = reactive({
  phone: false,
  idCard: false,
  bankCard: false,
  email: false,
  apiKey: false,
});

// --- Models & API state ---
type ApiFormat = ModelApiFormat;
type ReasoningEffort = ModelReasoningEffort;

interface ModelEntry {
  providerKey: string;
  id: string;
  name: string;
  source: "managed" | "custom" | "auth-managed";
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: ApiFormat;
  reasoningEffort?: ReasoningEffort;
  input?: ModelInputCapability[];
}

function normalizeApiFormat(api?: string): ApiFormat {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "openai-responses") return "openai-responses";
  return "openai-chat";
}

function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = "off",
): ReasoningEffort {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "adaptive"
  ) {
    return normalized;
  }
  return fallback;
}

function getModelRef(model: Pick<ModelEntry, "providerKey" | "id">): string {
  return `${model.providerKey}/${model.id}`;
}

const customModels = ref<ModelEntry[]>([]);
const selectedModel = ref("Pony-Alpha-2");
const copilotModelsLoading = ref(false);
const copilotDisconnecting = ref(false);
const switchingModelRef = ref("");
const removingModelRef = ref("");
let copilotModelsGeneration = 0;
const showProviderSetup = ref(false);
const selectedModelEntry = computed(
  () => customModels.value.find((model) => getModelRef(model) === selectedModel.value) ?? null,
);
const selectedModelIndex = computed(() =>
  customModels.value.findIndex((model) => getModelRef(model) === selectedModel.value),
);

// Display name of the configured provider shown in the Model section.
const currentProviderName = computed(() => {
  const entry = selectedModelEntry.value;
  if (!entry) return "";
  if (entry.providerKey === "github-copilot") return "GitHub Copilot";
  return getManagedModelProvider(entry.providerKey)?.label ?? entry.providerKey;
});

// --- Web search providers ---
type SearchProviderId = "parallel-free" | "brave" | "tavily";
const searchProviders: {
  id: SearchProviderId;
  name: string;
  placeholder: string;
  link: string;
  requiresKey: boolean;
}[] = [
  {
    id: "parallel-free",
    name: "Parallel",
    placeholder: "",
    link: "https://parallel.ai/",
    requiresKey: false,
  },
  {
    id: "brave",
    name: "Brave",
    placeholder: "BSA...",
    link: "https://brave.com/search/api/",
    requiresKey: true,
  },
  {
    id: "tavily",
    name: "Tavily",
    placeholder: "tvly-...",
    link: "https://tavily.com/",
    requiresKey: true,
  },
];
const searchProvider = ref<SearchProviderId>("parallel-free");
const searchKeys = reactive<Record<SearchProviderId, string>>({
  "parallel-free": "",
  brave: "",
  tavily: "",
});
// The provider metadata (placeholder, docs link) for the currently selected provider.
const activeSearchProvider = computed(
  () => searchProviders.find((p) => p.id === searchProvider.value) ?? searchProviders[0],
);
// Snapshot of the last persisted state, used to drive the "Configured" status and the
// enabled/disabled state of the single Save button.
const savedSearchProvider = ref<SearchProviderId>("parallel-free");
const savedSearchKeys = reactive<Record<SearchProviderId, string>>({
  "parallel-free": "",
  brave: "",
  tavily: "",
});
const searchSavingAll = ref(false);
const searchDirty = computed(() => {
  if (searchProvider.value !== savedSearchProvider.value) return true;
  return searchProviders.some((p) => searchKeys[p.id].trim() !== savedSearchKeys[p.id]);
});

// --- Usage state ---
interface UsageStats {
  totalSpend: number;
  maxBudget: number | null;
  modelSpend: Record<string, number>;
  keyName: string;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalRequests: number;
  modelBreakdown: Record<
    string,
    { requests: number; promptTokens: number; completionTokens: number; spend: number }
  >;
  dailySpend: Record<string, number>;
  hasDetailedLogs: boolean;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  sessionCount?: number;
  toolCalls?: number;
  /** CNY per 1 USD, provided by the main process to convert relayed USD spend. */
  exchangeRate?: number;
  /** Display currency code for spend values (e.g. "CNY"). */
  currency?: string;
}
const usageData = ref<UsageStats | null>(null);
const usageLoading = ref(false);
const usageError = ref("");

// The gateway relays spend in USD; convert to CNY for display using the live rate
// from the main process (defaults to the fallback rate until stats load).
// Fallback mirrors USD_TO_CNY_FALLBACK_RATE in the main process (approx. 2026 rate).
const USD_TO_CNY_FALLBACK_RATE = 7.2;
function toCny(usd: number | null | undefined): number {
  const rate = usageData.value?.exchangeRate ?? USD_TO_CNY_FALLBACK_RATE;
  return (usd ?? 0) * rate;
}

const usageModelList = computed(() => {
  if (!usageData.value) return [];
  // Use detailed breakdown if available, otherwise fall back to modelSpend
  if (usageData.value.hasDetailedLogs && Object.keys(usageData.value.modelBreakdown).length) {
    return Object.entries(usageData.value.modelBreakdown).map(([name, d]) => ({
      name,
      requests: d.requests,
      promptTokens: d.promptTokens,
      completionTokens: d.completionTokens,
      spend: d.spend,
    }));
  }
  return Object.entries(usageData.value.modelSpend).map(([name, spend]) => ({
    name,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    spend,
  }));
});

async function loadUsage() {
  usageLoading.value = true;
  usageError.value = "";
  try {
    usageData.value = await (window as any).openclaw.usage.getStats();
  } catch (err: any) {
    usageError.value = err.message || t("settings.usageLoadFailed");
    usageData.value = null;
  } finally {
    usageLoading.value = false;
  }
}

const svg = {
  general: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h3M10 5h7M3 10h7M14 10h3M3 15h2M9 15h8"/><circle cx="8" cy="5" r="2"/><circle cx="12" cy="10" r="2"/><circle cx="7" cy="15" r="2"/></svg>`,
  usage: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="3" height="5" rx="1"/><rect x="8.5" y="8" width="3" height="9" rx="1"/><rect x="14" y="4" width="3" height="13" rx="1"/></svg>`,
  models: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="9" height="9" rx="2"/><path d="M8 3v2.5M12 3v2.5M8 14.5V17M12 14.5V17M3 8h2.5M3 12h2.5M14.5 8H17M14.5 12H17"/><path d="m10 7 .7 2.3L13 10l-2.3.7L10 13l-.7-2.3L7 10l2.3-.7L10 7z"/></svg>`,
  channels: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/><path d="M6.8 6.8a4.5 4.5 0 0 0 0 6.4M13.2 6.8a4.5 4.5 0 0 1 0 6.4M4.4 4.4a8 8 0 0 0 0 11.2M15.6 4.4a8 8 0 0 1 0 11.2"/></svg>`,
  skills: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 3.5a2.5 2.5 0 0 1 5 0v2h2a2.5 2.5 0 1 1 0 5h-2v2a2.5 2.5 0 1 1-5 0v-2h-2a2.5 2.5 0 1 1 0-5h2v-2z"/></svg>`,
  security: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l6 3v5c0 4-2.5 6.5-6 8-3.5-1.5-6-4-6-8V5l6-3z"/><path d="M7.5 10l2 2 3.5-4"/></svg>`,
  privacy: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="9" rx="2"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/><circle cx="10" cy="14" r="1" fill="currentColor" stroke="none"/></svg>`,
  about: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 9v5"/><circle cx="10" cy="6.5" r="0.75" fill="currentColor" stroke="none"/></svg>`,
};

const menuItems = computed(() => [
  { id: "general", label: t("settings.menu.general"), color: "#636366", svg: svg.general },
  { id: "usage", label: t("settings.menu.usage"), color: "#636366", svg: svg.usage },
  { id: "models", label: t("settings.menu.models"), color: "#636366", svg: svg.models },
  { id: "channels", label: t("settings.menu.channels"), color: "#636366", svg: svg.channels },
  ...(devSettingsEnabled
    ? [{ id: "skills", label: t("settings.menu.skills"), color: "#636366", svg: svg.skills }]
    : []),
  { id: "security", label: t("settings.menu.security"), color: "#636366", svg: svg.security },
  { id: "privacy", label: t("settings.menu.privacy"), color: "#636366", svg: svg.privacy },
  { id: "about", label: t("settings.menu.about"), color: "#636366", svg: svg.about },
]);

// --- Theme helpers ---
function applyTheme(mode: string) {
  const html = document.documentElement;
  html.classList.remove("light", "dark");
  if (mode === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    html.classList.add(prefersDark ? "dark" : "light");
  } else {
    html.classList.add(mode);
  }
}

// --- Persist settings on change ---
watch(
  () => settings.language,
  (v) => {
    window.openclaw.settings.set("language", v);
    setLocale(v as Locale);
  },
);

watch(activeSection, (section) => {
  if (section === "security") windowsNodeMxcTechnicalDetailsOpen.value = false;
});
watch(
  () => settings.autoStart,
  (v) => window.openclaw.settings.set("autoStart", v),
);
watch(
  () => settings.minimizeToTray,
  (v) => window.openclaw.settings.set("minimizeToTray", v),
);
watch(
  () => settings.themeMode,
  (v) => {
    window.openclaw.settings.set("themeMode", v);
    applyTheme(v);
  },
);

function currentPrivacyControls(): PrivacyControls {
  return { ...piiToggles };
}

function applyPrivacyControls(controls: PrivacyControls) {
  piiToggles.phone = controls.phone;
  piiToggles.idCard = controls.idCard;
  piiToggles.bankCard = controls.bankCard;
  piiToggles.email = controls.email;
  piiToggles.apiKey = controls.apiKey;
}

function persistPrivacyControls() {
  return window.openclaw.settings.set("privacyControls", currentPrivacyControls());
}

function setPrivacyLevel(level: PrivacyLevel) {
  settings.privacyLevel = level;
  applyPrivacyControls(hydratePrivacyControls(level));
  void Promise.all([window.openclaw.settings.set("privacyLevel", level), persistPrivacyControls()]);
}

// --- Auto-load data when tab is selected ---
watch(activeSection, (v) => {
  if (v === "usage" && !usageData.value && !usageLoading.value) {
    loadUsage();
  }
  if (v === "models" && !showProviderSetup.value) {
    void refreshModelsConfig();
  }
  if (v === "security") {
    void Promise.all([loadSandboxStatus(), loadWindowsNodeMxcStatus()]);
  }
});

function applyModelsConfig(config: any): void {
  const providers = config.models?.providers ?? {};
  const modelDefaults = config.agents?.defaults?.models ?? {};
  const defaultModelConfig = config.agents?.defaults?.model;
  const primary =
    typeof defaultModelConfig === "string" ? defaultModelConfig : defaultModelConfig?.primary;
  const loaded: ModelEntry[] = [];
  for (const [key, val] of Object.entries(providers) as [string, any][]) {
    const managedProvider = getManagedModelProvider(key);
    const models = val.models ?? [];
    for (const m of models) {
      const modelId = m.id ?? key;
      const modelRef = `${key}/${modelId}`;
      const managedModel = managedProvider?.models.find((model) => model.id === modelId);
      const apiFormat = normalizeApiFormat(val.api);
      const reasoningFallback =
        m.reasoning === true || apiFormat === "openai-responses" ? "low" : "off";
      loaded.push({
        providerKey: key,
        id: modelId,
        name: m.name ?? managedModel?.name ?? modelId ?? key,
        source: managedProvider ? "managed" : "custom",
        baseUrl: val.baseUrl ?? "",
        apiKey: val.apiKey ?? "",
        apiFormat,
        reasoningEffort: normalizeReasoningEffort(
          modelDefaults[modelRef]?.params?.thinking,
          reasoningFallback,
        ),
        input: normalizeModelInput(m.input ?? managedModel?.input),
      });
    }
  }
  if (
    typeof primary === "string" &&
    primary.startsWith("github-copilot/") &&
    !loaded.some((model) => getModelRef(model) === primary)
  ) {
    const modelId = primary.slice("github-copilot/".length);
    loaded.unshift({
      providerKey: "github-copilot",
      id: modelId,
      name: modelId,
      source: "auth-managed",
    });
  }
  customModels.value = loaded;

  if (primary) {
    const matched = loaded.find((model) => getModelRef(model) === primary);
    selectedModel.value = matched ? getModelRef(matched) : primary;
  } else if (loaded.length > 0) {
    selectedModel.value = getModelRef(loaded[0]);
  } else {
    selectedModel.value = "";
  }
}

async function loadSettingsGitHubCopilotModels(): Promise<void> {
  const generation = ++copilotModelsGeneration;
  copilotModelsLoading.value = true;
  const modelsPromise = window.openclaw.model.listGitHubCopilotModels();
  void modelsPromise.catch(() => {});

  try {
    const status = await window.openclaw.model.getGitHubCopilotStatus();
    if (generation !== copilotModelsGeneration) return;
    if (!status.authenticated) {
      copilotModelsLoading.value = false;
      return;
    }

    const models = await modelsPromise;
    if (generation !== copilotModelsGeneration) return;
    customModels.value = mergeGitHubCopilotModelEntries(customModels.value, models);
  } catch (error) {
    if (generation !== copilotModelsGeneration) return;
    console.warn("[settings] Could not load GitHub Copilot models:", error);
  } finally {
    if (generation === copilotModelsGeneration) copilotModelsLoading.value = false;
  }
}

async function refreshModelsConfig(): Promise<void> {
  try {
    const config = await window.openclaw.config.read();
    if (!config) return;
    applyModelsConfig(config);
    void loadSettingsGitHubCopilotModels();
  } catch (error) {
    console.warn("[settings] Failed to refresh model configuration:", error);
  }
}

function handleSettingsWindowFocus(): void {
  if (activeSection.value === "models" && !showProviderSetup.value) {
    void refreshModelsConfig();
  } else if (activeSection.value === "security") {
    void loadWindowsNodeMxcStatus();
  }
}

watch(showProviderSetup, (visible, wasVisible) => {
  if (wasVisible && !visible) void refreshModelsConfig();
});

onMounted(async () => {
  window.addEventListener("focus", handleSettingsWindowFocus);
  // Load persisted app settings
  const saved = await window.openclaw.settings.get();
  if (saved) {
    settings.language = saved.language ?? "en-US";
    settings.autoStart = saved.autoStart ?? false;
    settings.minimizeToTray = saved.minimizeToTray ?? false;
    settings.themeMode = saved.themeMode ?? "light";
    const savedPrivacyLevel: string | undefined = saved.privacyLevel;
    settings.privacyLevel = savedPrivacyLevel === "strict" ? "strict" : "basic";
    applyPrivacyControls(hydratePrivacyControls(settings.privacyLevel, saved.privacyControls));
    await persistPrivacyControls();
    if (savedPrivacyLevel === "balanced") {
      await window.openclaw.settings.set("privacyLevel", "basic");
    }
  }

  // Load existing model config
  const config = await window.openclaw.config.read();
  if (config) {
    applyModelsConfig(config);
    void loadSettingsGitHubCopilotModels();
  }

  // Load web search provider configuration
  loadSearchConfig(config);
  if (activeSection.value === "security") {
    await Promise.all([loadSandboxStatus(), loadWindowsNodeMxcStatus()]);
  }
});

onUnmounted(() => {
  window.removeEventListener("focus", handleSettingsWindowFocus);
  copilotModelsGeneration += 1;
});

// --- Model & Gateway actions ---

async function handleProviderConfigured(): Promise<void> {
  await refreshModelsConfig();
  ElMessage.success(t("settings.providerConfigured"));
}

async function restartGatewayAfterModelConfig(
  options: { waitForRendererReconnect?: boolean } = {},
): Promise<void> {
  await window.openclaw.gateway.restart();
  if (options.waitForRendererReconnect !== false) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function persistAndRestart(
  mutate: (config: Record<string, unknown>) => Record<string, unknown>,
  successMsg: string,
): Promise<boolean> {
  try {
    const existing = await window.openclaw.config.read();
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("OpenClaw configuration is unavailable");
    }
    const nextConfig = mutate(existing);
    await window.openclaw.config.write(nextConfig);
  } catch (err: any) {
    ElMessage.error(t("settings.configSaveFailed", { error: err.message || err }));
    await refreshModelsConfig();
    return false;
  }
  try {
    await restartGatewayAfterModelConfig();
  } catch (err: any) {
    ElMessage.error(t("settings.restartFailed", { error: err.message || err }));
    await refreshModelsConfig();
    return false;
  }
  await refreshModelsConfig();
  ElMessage.success(successMsg);
  return true;
}

async function selectModel(modelRef: string) {
  if (switchingModelRef.value || removingModelRef.value || copilotDisconnecting.value) return;
  if (!customModels.value.some((model) => getModelRef(model) === modelRef)) {
    ElMessage.error(t("settings.configSaveFailed", { error: `Unknown model "${modelRef}"` }));
    return;
  }
  switchingModelRef.value = modelRef;
  try {
    await persistAndRestart(
      (config) => {
        const selected = selectPrimaryModelConfig(config, modelRef);
        // Keep only the active model's provider so the config never accumulates stale providers.
        const providerKey = modelRef.split("/")[0];
        return retainOnlyProvider(selected, providerKey);
      },
      t("settings.modelSwitched", { model: modelRef }),
    );
  } finally {
    switchingModelRef.value = "";
  }
}

async function removeCustomModel(idx: number) {
  if (switchingModelRef.value || removingModelRef.value || copilotDisconnecting.value) return;
  const removed = customModels.value[idx];
  if (!removed || removed.source === "auth-managed") return;
  const modelRef = getModelRef(removed);
  const fallback = customModels.value.find(
    (model, modelIndex) => modelIndex !== idx && model.source !== "auth-managed",
  );
  removingModelRef.value = modelRef;
  try {
    const existing = await window.openclaw.config.read();
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("OpenClaw configuration is unavailable");
    }
    const nextConfig = removeModelProviderConfig(
      existing,
      removed.providerKey,
      removed.id,
      fallback ? getModelRef(fallback) : undefined,
    );
    await window.openclaw.config.write(nextConfig);
    applyModelsConfig(nextConfig);
    ElMessage.success(t("settings.customModelDeleted"));
  } catch (err: any) {
    ElMessage.error(t("settings.configSaveFailed", { error: err.message || err }));
    await refreshModelsConfig();
    removingModelRef.value = "";
    return;
  }

  try {
    await restartGatewayAfterModelConfig({ waitForRendererReconnect: false });
  } catch (err: any) {
    ElMessage.warning(t("settings.restartFailed", { error: err.message || err }));
  } finally {
    await refreshModelsConfig();
    removingModelRef.value = "";
  }
}

async function disconnectGitHubCopilot() {
  if (switchingModelRef.value || removingModelRef.value || copilotDisconnecting.value) return;
  try {
    await ElMessageBox.confirm(t("settings.copilotDisconnectConfirm"), t("settings.confirm"), {
      type: "warning",
    });
  } catch {
    return;
  }

  const fallbackModel = customModels.value.find(
    (model) => model.providerKey !== "github-copilot" && model.source !== "auth-managed",
  );
  const fallbackModelRef = fallbackModel ? getModelRef(fallbackModel) : undefined;
  copilotDisconnecting.value = true;
  copilotModelsGeneration += 1;
  copilotModelsLoading.value = false;

  try {
    const existingConfig = await window.openclaw.config.read();
    if (!existingConfig || typeof existingConfig !== "object" || Array.isArray(existingConfig)) {
      throw new Error(t("settings.copilotConfigUnavailable"));
    }
    const nextConfig = removeGitHubCopilotModelReferences(existingConfig, fallbackModelRef);
    await window.openclaw.config.write(nextConfig);

    await window.openclaw.model.disconnectGitHubCopilot();

    try {
      await restartGatewayAfterModelConfig();
    } catch (error) {
      await refreshModelsConfig();
      ElMessage.warning(
        t("settings.copilotDisconnectedRestartFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    await refreshModelsConfig();
    ElMessage.success(t("settings.copilotDisconnected"));
  } catch (error) {
    await refreshModelsConfig();
    ElMessage.error(
      t("settings.copilotDisconnectFailed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    copilotDisconnecting.value = false;
  }
}

function loadSearchConfig(config: any): void {
  const active = config?.tools?.web?.search;
  if (searchProviders.some((provider) => provider.id === active?.provider)) {
    const provider: SearchProviderId = active.provider;
    searchProvider.value = provider;
    if (typeof active.apiKey === "string" && active.apiKey) {
      searchKeys[provider] = active.apiKey;
    }
  }
  snapshotSearchConfig();
}

// Records the current selection + keys as the persisted baseline that drives the Configured
// status badges and whether the Save button is enabled.
function snapshotSearchConfig(): void {
  savedSearchProvider.value = searchProvider.value;
  for (const p of searchProviders) savedSearchKeys[p.id] = searchKeys[p.id].trim();
}

// Writes only the active provider into tools.web.search — the single object the gateway
// consumes. The gateway schema rejects any extra keys under tools.web, so no per-provider map
// is persisted; unsaved keys for other providers live only in-memory for quick switching.
async function persistSearchConfig(): Promise<void> {
  const config = (await window.openclaw.config.read()) || {};
  config.tools = config.tools || {};
  config.tools.web = config.tools.web || {};
  delete config.tools.web.searchProviders;
  const activeKey = searchKeys[searchProvider.value].trim();
  if (!activeSearchProvider.value.requiresKey) {
    config.tools.web.search = { provider: searchProvider.value };
  } else if (activeKey) {
    config.tools.web.search = { provider: searchProvider.value, apiKey: activeKey };
  } else {
    delete config.tools.web.search;
  }
  await window.openclaw.config.write(config);
}

async function saveSearchSettings(): Promise<void> {
  searchSavingAll.value = true;
  try {
    await persistSearchConfig();
    snapshotSearchConfig();
    ElMessage.success(t("settings.searchSettingsSaved"));
  } catch (err: any) {
    ElMessage.error(t("settings.saveFailed", { error: err.message || err }));
  } finally {
    searchSavingAll.value = false;
  }
}

function openExternal(url: string) {
  window.openclaw.shell.openExternal(url);
}

async function checkForUpdates() {
  updateChecking.value = true;
  try {
    updateResult.value = await window.openclaw.updates.check();
    if (updateResult.value.status === "update-available") {
      ElMessage.success(t("settings.updateAvailableToast"));
    } else if (updateResult.value.status === "up-to-date") {
      ElMessage.success(t("settings.updateUpToDate"));
    } else if (updateResult.value.status === "managed-by-store") {
      ElMessage.success(t("settings.updateManagedByStore"));
    } else {
      ElMessage.error(t("settings.updateCheckFailed"));
    }
  } catch (err: any) {
    updateResult.value = {
      status: "error",
      currentVersion: "unknown",
      message: err?.message || String(err),
    };
    ElMessage.error(t("settings.updateCheckFailed"));
  } finally {
    updateChecking.value = false;
  }
}

function openUpdateDownload() {
  if (updateResult.value?.status === "update-available") {
    window.openclaw.shell.openExternal(updateResult.value.downloadUrl);
  }
}

async function restartGateway() {
  try {
    await window.openclaw.gateway.restart();
    ElMessage.success(t("settings.gatewayRestarting"));
  } catch (err: any) {
    ElMessage.error(t("settings.restartFailed", { error: err.message }));
  }
}

async function exportGatewayLogs() {
  if (exportingGatewayLogs.value || gateway.logs.length === 0) return;
  exportingGatewayLogs.value = true;
  try {
    const result = await window.openclaw.logs.exportGateway([...gateway.logs]);
    if (!result.canceled) {
      ElMessage.success(t("settings.gatewayLogsExported"));
    }
  } catch (err: any) {
    ElMessage.error(t("settings.gatewayLogsExportFailed", { error: err.message }));
  } finally {
    exportingGatewayLogs.value = false;
  }
}

async function clearChatHistory() {
  try {
    await ElMessageBox.confirm(t("settings.clearHistoryConfirm"), t("settings.confirm"), {
      type: "warning",
    });
  } catch {
    return; // Cancelled
  }
  try {
    await chatStore.clearAllHistory();
    ElMessage.success(t("settings.chatHistoryCleared"));
  } catch (err: any) {
    ElMessage.error(t("settings.chatHistoryClearFailed", { error: err?.message ?? String(err) }));
  }
}
</script>

<style scoped>
.settings-view {
  display: flex;
  flex: 1;
  min-height: 0;
  background: var(--bg-primary);
  font-family: inherit;
}

/* ── Left sidebar ── */
.settings-sidebar {
  width: clamp(160px, 18vw, 210px);
  min-width: 160px;
  background: var(--bg-primary);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 20px 0 12px;
}

.menu-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-menu-item {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 8px 16px;
  cursor: pointer;
  border-radius: 8px;
  margin: 0 8px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  transition: background 0.1s;
}

.settings-menu-item:hover {
  background: var(--accent-subtle);
}

.settings-menu-item.active {
  background: #1d1d1f;
  color: #fff;
}

.menu-icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-secondary);
  background: none !important;
}

.settings-menu-item.active .menu-icon {
  color: #fff;
  background: none !important;
}

.menu-icon :deep(svg) {
  display: block;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
}

.menu-label {
  font-size: 13px;
}

/* ── Right content ── */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 28px clamp(16px, 3vw, 32px);
  container-type: inline-size;
}

.settings-content--skills {
  display: flex;
  overflow: hidden;
  padding: 0;
}

.section-label,
.sub-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.section-label {
  margin-bottom: 8px;
  padding-left: 4px;
}

.section-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-label-row .section-label {
  margin-bottom: 0;
}

/* Grouped card */
.card-group {
  background: var(--bg-grouped);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
}

.card-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-row);
  gap: 12px;
  min-height: 52px;
}

@container (max-width: 500px) {
  .card-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .row-value {
    text-align: left;
    max-width: 100%;
  }

  .budget-bar-wrapper {
    width: 100%;
    align-items: flex-start;
  }

  .model-picker-actions {
    align-self: stretch;
    width: 100%;
    flex-wrap: wrap;
  }

  .model-picker-select {
    flex: 1;
    min-width: 220px;
  }
}

.card-row.no-border {
  border-bottom: none;
}

.row-label {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
  flex-shrink: 1;
  min-width: 0;
}

.language-select {
  width: 140px;
  height: 32px;
  flex-shrink: 0;
  padding: 0 32px 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  appearance: none;
  background-color: var(--bg-input);
  background-image: url("data:image/svg+xml,%3Csvg width='14' height='14' viewBox='0 0 14 14' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3.5 5.25L7 8.75L10.5 5.25' stroke='%236B7280' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 12px center;
  background-repeat: no-repeat;
  background-size: 14px 14px;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.language-select:hover {
  border-color: var(--text-muted);
}

.language-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.row-value {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
  min-width: 0;
  flex-shrink: 1;
}

.placeholder-row {
  justify-content: center;
  padding: 20px 16px;
}

.placeholder-text {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
  text-align: center;
}

.section-footer {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  padding: 6px 4px 0;
}

/* About card */
.about-section {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.about-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.about-card {
  flex: 1;
  background: var(--bg-grouped);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 28px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.about-card-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.about-icon {
  width: 52px;
  height: 52px;
  object-fit: contain;
  margin-bottom: 4px;
}

.about-name {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.about-version {
  font-size: 13px;
  color: var(--text-secondary);
}

.update-check-btn {
  margin-top: 10px;
}

.copyright-notice {
  margin: 0;
  padding-top: 16px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.update-card {
  margin-top: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-grouped);
}

.update-card-update-available {
  border-color: rgba(59, 130, 246, 0.35);
}

.update-card-error {
  border-color: rgba(239, 68, 68, 0.35);
}

.update-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.update-detail {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.update-notes {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.update-download-btn {
  margin-top: 12px;
}

/* Models & API */
.sub-label-actions {
  display: flex;
  gap: 8px;
}

.sub-label {
  margin-bottom: 10px;
  margin-top: 32px;
  padding-left: 4px;
}

.sub-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 32px;
  margin-bottom: 10px;
}

.section > .sub-label-row:first-child {
  margin-top: 0;
}

.sub-label-row .sub-label {
  margin: 0;
}

.sub-label-row > .status-indicator,
.sub-label-actions > .status-indicator {
  margin-right: 12px;
}

.custom-model-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.custom-model-info .row-sub {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-picker-row {
  gap: 24px;
}

.model-picker-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.model-picker-select {
  width: 360px;
}

.search-provider-group {
  display: flex;
  flex-direction: column;
  width: 100%;
  align-items: stretch;
}

/* Higher specificity than .card-row so the row content is truly left-aligned. */
.search-provider-group .card-row {
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 10px;
}

.provider-key-input {
  min-width: 240px;
  max-width: 340px;
}

/* API key row: [label] [get-key link] on the left, key input right-aligned. */
.api-key-row {
  justify-content: flex-start;
}

.api-key-row .provider-key-input {
  margin-left: auto;
}

/* Shared status indicator (dot + text) — the single status style across Settings. */
.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
}

.status-indicator--ok {
  color: #16a34a;
}

.status-indicator--error {
  color: #ff3b30;
}

.status-indicator--warn {
  color: #b26a00;
}

.status-indicator--muted {
  color: var(--text-secondary);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.sensitive-file-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sensitive-file-examples {
  color: var(--text-muted);
  font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
  font-size: 11px;
  line-height: 1.4;
}

.provider-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.provider-link-arrow {
  font-size: 11px;
  text-decoration: none;
}

.provider-link:hover {
  opacity: 0.8;
}

.settings-view :deep(.el-input__inner),
.settings-view :deep(.el-select__selected-item),
.settings-view :deep(.el-radio__label) {
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
}

.settings-view :deep(.el-button) {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--settings-action-border);
  border-radius: 6px;
  background: var(--settings-action-bg);
  color: var(--settings-action-fg);
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  transition:
    background 0.1s,
    border-color 0.1s,
    color 0.1s;
}

.settings-view :deep(.el-button:hover) {
  border-color: var(--settings-action-border);
  background: var(--settings-action-hover);
  color: var(--settings-action-fg);
}

.settings-view :deep(.el-button + .el-button) {
  margin-left: 0;
}

.settings-view :deep(.el-button:active) {
  background: var(--settings-action-active);
}

.settings-view :deep(.el-button:focus-visible),
.tag-remove:focus-visible,
.tag-add-btn:focus-visible,
.dir-add-btn:focus-visible {
  outline: 2px solid var(--settings-action-focus);
  outline-offset: 2px;
}

.settings-view :deep(.el-button--primary:not(.is-plain, .is-text)) {
  border-color: var(--settings-action-primary);
  background: var(--settings-action-primary);
  color: var(--settings-action-primary-fg);
}

.settings-view :deep(.el-button--primary:not(.is-plain, .is-text):hover) {
  border-color: var(--settings-action-primary-hover);
  background: var(--settings-action-primary-hover);
  color: var(--settings-action-primary-fg);
}

.settings-view :deep(.el-button--primary:not(.is-plain, .is-text):active) {
  border-color: var(--settings-action-primary-active);
  background: var(--settings-action-primary-active);
}

.settings-view :deep(.el-button.is-plain) {
  border-color: var(--settings-action-border);
  background: transparent;
  color: var(--settings-action-fg);
}

.settings-view :deep(.el-button.is-plain:hover) {
  border-color: var(--settings-action-border);
  background: var(--settings-action-hover);
  color: var(--settings-action-fg);
}

.settings-view :deep(.el-button--danger.is-plain) {
  border-color: color-mix(in srgb, var(--settings-action-danger) 50%, transparent);
  color: var(--settings-action-danger);
}

.settings-view :deep(.el-button--danger.is-plain:hover) {
  border-color: var(--settings-action-danger);
  background: var(--settings-action-danger);
  color: #ffffff;
}

.settings-view :deep(.el-button--danger.is-plain:active) {
  border-color: var(--settings-action-danger-active);
  background: var(--settings-action-danger-active);
}

.settings-view :deep(.el-button.is-text) {
  min-height: 28px;
  padding: 0 8px;
  border-color: transparent;
  background: transparent;
  color: var(--settings-action-fg);
}

.settings-view :deep(.el-button.is-text:hover) {
  border-color: transparent;
  background: var(--settings-action-hover);
  color: var(--settings-action-fg);
}

.settings-view :deep(.el-button--danger.is-text) {
  color: var(--settings-action-danger);
}

.settings-view :deep(.el-button.is-disabled),
.settings-view :deep(.el-button.is-disabled:hover) {
  border-color: var(--settings-action-border);
  background: var(--settings-action-bg);
  color: var(--text-muted);
  opacity: 0.55;
}

.test-result {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-grouped);
  font-size: 13px;
}

.test-ok {
  color: #34c759;
}

.test-fail {
  color: #ff3b30;
}

.switch-wrap {
  display: inline-flex;
  align-items: center;
}

/* Usage section */
.usage-refresh-btn {
  width: 28px;
  height: 28px;
  margin-right: 12px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.usage-refresh-btn:hover:not(:disabled) {
  background: var(--settings-action-hover);
  color: var(--text-primary);
}

.usage-refresh-btn:disabled {
  cursor: default;
  opacity: 0.65;
}

.usage-refresh-btn:focus-visible {
  outline: 2px solid var(--settings-action-focus);
  outline-offset: 2px;
}

.usage-refresh-btn svg {
  width: 16px;
  height: 16px;
}

.usage-refresh-btn svg.is-spinning {
  animation: usage-refresh-spin 0.8s linear infinite;
}

@keyframes usage-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

.usage-spend {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.budget-bar-wrapper {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  min-width: 120px;
  flex: 1;
}

.budget-bar {
  width: 100%;
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}

.budget-bar-fill {
  height: 100%;
  background: var(--accent, #1e1f25);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.model-usage-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.model-usage-info .row-sub {
  font-size: 12px;
  color: var(--text-muted);
}

/* Sandbox external apps */
.mxc-card {
  border: 1px solid color-mix(in srgb, var(--accent-color) 35%, var(--border));
}
.mxc-subtitle {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 12px;
}
.mxc-state {
  font-size: 12px;
  font-weight: 700;
}
.mxc-state-ok {
  color: #4caf50;
}
.mxc-state-blocked {
  color: var(--settings-action-danger);
}
.mxc-state-neutral {
  color: var(--text-muted);
}
.mxc-primary-detail {
  padding: 0 24px 14px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.mxc-technical-summary {
  width: 100%;
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border: 0;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.mxc-technical-summary:hover {
  background: var(--bg-hover);
}
.mxc-technical-summary:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: -3px;
}
.mxc-technical-chevron {
  color: var(--text-muted);
  font-size: 18px;
}
.mxc-technical-details {
  border-top: 1px solid var(--border);
}
.mxc-technical-details .row-value {
  max-width: 65%;
  overflow-wrap: anywhere;
  text-align: right;
}
.mxc-folder-policy {
  gap: 8px;
}
.mxc-folder-policy-hint {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}
.mxc-folder-policy-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.mxc-folder-policy-locked {
  margin-top: 0;
}
.mxc-folder-policy .dir-item {
  gap: 8px;
}
.mxc-folder-policy .dir-path {
  flex: 1;
}
.mxc-folder-policy .tag-remove:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.mxc-folder-policy-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.mxc-durable-approval {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.mxc-durable-approval .el-button {
  align-self: flex-start;
  margin-top: 4px;
}
.mxc-actions {
  justify-content: flex-end;
  gap: 8px;
}
.mxc-alert {
  margin-top: 8px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.mxc-alert-warning {
  border-color: rgba(230, 162, 60, 0.45);
  background: rgba(230, 162, 60, 0.08);
}
.mxc-alert-error {
  border-color: color-mix(in srgb, var(--settings-action-danger) 45%, transparent);
  background: color-mix(in srgb, var(--settings-action-danger) 8%, transparent);
}
.external-apps-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.app-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 13px;
  font-weight: 400;
  color: var(--text-secondary);
}
.app-tag .tag-remove {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}
.app-tag .tag-remove:hover {
  background: color-mix(in srgb, var(--settings-action-danger) 12%, transparent);
  color: var(--settings-action-danger);
}
.app-tag-add {
  border-style: dashed;
}
.app-add-input {
  background: none;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  width: 80px;
  color: var(--text-primary);
}
.tag-add-btn {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--settings-action-fg);
  cursor: pointer;
  font-size: 16px;
  font-weight: 400;
  padding: 0;
  line-height: 1;
}
.tag-add-btn:hover {
  background: var(--settings-action-hover);
}

.dir-add-btn {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--settings-action-border);
  border-radius: 6px;
  background: var(--settings-action-bg);
  color: var(--settings-action-fg);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  transition:
    background 0.1s,
    border-color 0.1s,
    color 0.1s;
}

.dir-add-btn:hover:not(:disabled) {
  background: var(--settings-action-hover);
}

.dir-add-btn:active:not(:disabled) {
  background: var(--settings-action-active);
}

.dir-add-btn:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
  opacity: 0.55;
}

/* Sandbox directory permissions */
.dir-section {
  margin-top: 4px;
}
.dir-section-label {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
}
.caps-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cap-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.cap-label {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
}
.sandbox-disabled {
  opacity: 0.45;
  pointer-events: none;
  user-select: none;
}
.restart-hint {
  font-size: 12px;
  color: #e6a23c;
  font-weight: 500;
}
.dir-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 400;
  background: var(--bg-tertiary);
}
.dir-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.dir-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}
.dir-badge-rw {
  background: rgba(46, 125, 50, 0.15);
  color: #4caf50;
}
.dir-badge-ro {
  background: rgba(21, 101, 192, 0.15);
  color: #42a5f5;
}
.dir-badge-system {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-weight: 600;
  font-size: 10px;
}
.dir-item-system {
  opacity: 0.7;
}
.dir-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 4px 0;
}

/* ACL Verification */
.acl-verify-results {
  margin-top: 8px;
}
.acl-section {
  margin-bottom: 10px;
}
.acl-section-header {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  padding: 2px 0;
}
.acl-ok {
  color: #67c23a;
}
.acl-warn {
  color: #e6a23c;
}
.acl-err {
  color: #f56c6c;
}
.acl-reason {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 8px;
}
.acl-summary-ok {
  font-size: 12px;
  color: #67c23a;
  padding: 8px 0;
  text-align: center;
}

/* ── Privacy Protection ── */
.privacy-levels {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.privacy-card {
  background: var(--bg-grouped);
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.privacy-card:hover {
  border-color: var(--text-muted);
}

.privacy-card.active {
  border-color: var(--accent-selected);
  box-shadow: 0 0 0 1px var(--accent-selected);
}

.privacy-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.privacy-card-icon {
  font-size: 16px;
}

.privacy-card-title {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
}

.privacy-card-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.privacy-card-list li {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  line-height: 1.6;
  padding-left: 12px;
  position: relative;
}

.privacy-card-list li::before {
  content: "•";
  position: absolute;
  left: 0;
  color: var(--text-muted);
}
</style>
