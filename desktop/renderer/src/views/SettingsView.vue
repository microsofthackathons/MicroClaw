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

        <div class="sub-label">{{ t("settings.gateway") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.connectionStatus") }}</span>
            <div style="display: flex; align-items: center; gap: 8px">
              <span
                class="status-indicator"
                :class="
                  gateway.status === 'running' ? 'status-indicator--ok' : 'status-indicator--error'
                "
              >
                <span class="status-dot"></span>
                {{ gateway.status === "running" ? t("settings.connected") : gateway.status }}
              </span>
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
          <el-button v-if="usageData" size="small" :loading="usageLoading" @click="loadUsage">{{
            t("settings.refresh")
          }}</el-button>
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
                  <span v-if="m.requests" class="row-sub"
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
      <div v-if="activeSection === 'models'" class="section model-settings-section">
        <div class="sub-label-row">
          <h2 class="model-section-title">{{ t("modelManager.providers") }}</h2>
        </div>
        <p class="provider-description">{{ t("modelManager.providersHint") }}</p>
        <p v-if="modelStatusError || providerCatalogError" class="provider-error" role="alert">
          {{ [modelStatusError, providerCatalogError].filter(Boolean).join("; ") }}
        </p>
        <SessionModelRecoveryNotice
          :disabled="chatStore.streaming || Boolean(switchingModelRef || localSelecting)"
          @state="sessionRecovery = $event"
          @busy="sessionRecovering = $event"
          @recovered="refreshModelsConfig"
        />
        <div class="card-group default-model-card">
          <template v-if="modelOptions.length">
            <div class="card-row no-border">
              <span class="row-label">{{ t("modelManager.defaultModel") }}</span>
              <div class="model-picker-actions">
                <DefaultModelPicker
                  class="model-picker-select"
                  :model-value="selectedModel"
                  :models="modelOptions"
                  :model-status="modelOptionStatus"
                  :loading="copilotModelsLoading || providerCatalogLoading || modelActionBusy"
                  :switching="Boolean(switchingModelRef) || localSelecting"
                  :disabled="modelActionBusy || chatStore.streaming || Boolean(sessionRecovery)"
                  @change="selectModel"
                />
              </div>
            </div>
          </template>
          <div v-else-if="!copilotModelsLoading" class="card-row no-border">
            <span class="placeholder-text">{{ t("settings.noProviderConfigured") }}</span>
          </div>
        </div>
        <div class="provider-cards">
          <section
            v-for="provider in providerCards"
            :key="provider.key"
            class="provider-card"
            :data-provider="provider.key"
          >
            <header class="provider-card-heading">
              <div class="provider-card-title">
                <strong>{{ provider.label }}</strong>
                <span v-if="provider.key === 'llama-cpp'" class="provider-runtime">llama.cpp</span>
                <p>
                  {{
                    provider.key === "llama-cpp"
                      ? t("modelManager.localHint")
                      : provider.key === "github-copilot"
                        ? t("modelManager.copilotHint")
                        : provider.signupUrl
                          ? t("modelManager.apiKeyHint")
                          : t("modelManager.apiHint")
                  }}
                </p>
              </div>
              <span class="provider-state" :class="{ warning: provider.missing }">
                {{
                  t(
                    provider.key === "llama-cpp" && localProviderReady
                      ? "settings.connected"
                      : provider.missing
                        ? "localModel.filesMissing"
                        : provider.models.length
                          ? "localModel.configured"
                          : "modelManager.notConfigured",
                  )
                }}
              </span>
              <button
                type="button"
                class="provider-toggle"
                :data-testid="
                  provider.key === 'llama-cpp'
                    ? 'add-local-model'
                    : `manage-provider-${provider.key}`
                "
                :aria-expanded="isProviderExpanded(provider.key)"
                :aria-controls="`provider-panel-${provider.key}`"
                :aria-label="
                  t(
                    isProviderExpanded(provider.key)
                      ? 'modelManager.collapseProvider'
                      : 'modelManager.expandProvider',
                    { provider: provider.label },
                  )
                "
                :disabled="
                  modelActionBusy ||
                  (provider.key === 'llama-cpp' && showLocalSetup && localOperation?.busy)
                "
                @click="toggleProvider(provider.key)"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  aria-hidden="true"
                  :class="{ 'provider-chevron-up': isProviderExpanded(provider.key) }"
                >
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </button>
            </header>
            <LocalModelSetupDialog
              v-if="provider.key === 'llama-cpp' && showLocalSetup"
              :id="`provider-panel-${provider.key}`"
              inline
              :target-model-ref="localTargetModel"
              :default-agent-override="defaultAgentOverride"
              :streaming="chatStore.streaming"
              :removable-connections="removableLocalConnections"
              :connection-mutation-busy="Boolean(removingModelRef)"
              @close="showLocalSetup = false"
              @configured="handleProviderConfigured"
              @remove-connection="removeLocalConnection"
            />
            <div
              v-if="
                provider.key === editingProviderKey &&
                showProviderSetup &&
                provider.key !== 'llama-cpp'
              "
              :id="`provider-panel-${provider.key}`"
              class="provider-editor"
            >
              <div
                v-for="model in provider.editableModels"
                :key="getModelRef(model)"
                class="provider-model-row"
              >
                <span>{{ model.name }}</span>
                <span v-if="getModelRef(model) === selectedModel" class="provider-state">{{
                  t("modelManager.defaultModel")
                }}</span>
                <el-button
                  v-if="model.source !== 'auth-managed'"
                  size="small"
                  text
                  :disabled="modelActionBusy"
                  @click="openCloudSetup(provider.key, model)"
                  >{{ t("modelManager.edit") }}</el-button
                >
                <el-button
                  v-if="model.source !== 'auth-managed'"
                  size="small"
                  text
                  type="danger"
                  :disabled="modelMutationBlocked"
                  @click="removeCustomModel(customModels.indexOf(model))"
                  >{{ t("localModel.removeConnection") }}</el-button
                >
              </div>
              <el-button
                v-if="provider.key === 'github-copilot' && provider.models.length"
                size="small"
                text
                type="danger"
                :disabled="modelMutationBlocked"
                @click="disconnectGitHubCopilot"
                >{{ t("settings.disconnect") }}</el-button
              >
              <ModelSetupDialog
                :key="editingModelRef"
                v-model="showProviderSetup"
                inline
                manage-only
                :initial-family="editingFamily"
                :current-provider="providerPrefill"
                :streaming="chatStore.streaming"
                @busy="providerSaving = $event"
                @configured="handleProviderConfigured"
              />
            </div>
          </section>
        </div>
        <div v-if="localOperation?.busy" class="local-setup-status" role="status">
          <span>{{ t("localModel.setupPending") }}</span>
          <el-button size="small" text @click="openLocalModel()">
            {{ t("localModel.viewSetup") }}
          </el-button>
        </div>

        <!-- Web search -->
        <div class="sub-label-row">
          <h2 class="model-section-title">{{ t("settings.webSearch") }}</h2>
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
        <div class="card-group" data-testid="web-search-settings">
          <div class="card-row" :class="{ 'no-border': !activeSearchProvider.requiresKey }">
            <span class="row-label">{{ t("settings.provider") }}</span>
            <div class="model-search-selector">
              <span v-if="!activeSearchProvider.requiresKey" class="model-search-hint">
                {{ t("settings.noApiKeyRequired") }}
              </span>
              <el-select v-model="searchProvider" style="width: 130px">
                <el-option v-for="p in searchProviders" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
            </div>
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
        </div>
        <div class="section-footer">{{ t("settings.webSearchDesc") }}</div>
        <LocalModelDownloadDialog
          v-if="localSelection"
          :key="localSelection"
          :model-ref="localSelection"
          :streaming="chatStore.streaming"
          @close="localSelection = ''"
          @busy="localSelecting = $event"
          @selected="handleLocalModelSelected"
        />
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
          <div class="mxc-heading">
            <span class="row-label">{{ t("settings.windowsNodeMxc") }}</span>
            <div class="mxc-subtitle">{{ t("settings.windowsNodeMxcExperimental") }}</div>
          </div>
          <div v-if="windowsNodeMxcStatus" class="mxc-mode-grid">
            <section
              class="mxc-mode-card"
              :class="{ selected: windowsNodeMxcStatus.requestedMode === 'full' }"
              data-testid="mxc-mode-full"
            >
              <div class="mxc-mode-card-heading">
                <strong>{{ t("settings.windowsNodeMxcModeFull") }}</strong>
                <span class="mxc-mode-badge">{{ t("settings.windowsNodeMxcFullBadge") }}</span>
              </div>
              <p>{{ t("settings.windowsNodeMxcModeFullDesc") }}</p>
              <p
                v-if="windowsNodeMxcStatus.fullAvailability.summary"
                class="mxc-availability-summary"
              >
                {{ windowsNodeMxcStatus.fullAvailability.summary }}
              </p>
              <ul
                v-if="
                  windowsNodeMxcStatus.fullAvailability.blockers.length ||
                  windowsNodeMxcStatus.fullAvailability.remediation.length
                "
                class="mxc-availability-list"
              >
                <li
                  v-for="blocker in windowsNodeMxcStatus.fullAvailability.blockers"
                  :key="`full-blocker-${blocker}`"
                  class="mxc-availability-blocker"
                >
                  {{ blocker }}
                </li>
                <li
                  v-for="step in windowsNodeMxcStatus.fullAvailability.remediation"
                  :key="`full-remediation-${step}`"
                >
                  {{ step }}
                </li>
              </ul>
              <el-button
                type="primary"
                plain
                data-testid="mxc-select-full"
                :loading="windowsNodeMxcApplying"
                :disabled="
                  windowsNodeMxcApplying ||
                  !windowsNodeMxcStatus.fullAvailability.available ||
                  windowsNodeMxcStatus.requestedMode === 'full'
                "
                @click="selectWindowsNodeMxcMode('full')"
              >
                {{
                  windowsNodeMxcStatus.requestedMode === "full"
                    ? t("settings.windowsNodeMxcSelected")
                    : t("settings.windowsNodeMxcUseFull")
                }}
              </el-button>
            </section>
            <section
              class="mxc-mode-card mxc-mode-card-limited"
              :class="{ selected: windowsNodeMxcStatus.requestedMode === 'limited-dacl' }"
              data-testid="mxc-mode-limited"
            >
              <div class="mxc-mode-card-heading">
                <strong>{{ t("settings.windowsNodeMxcModeLimited") }}</strong>
                <span class="mxc-mode-badge mxc-mode-badge-warning">{{
                  t("settings.windowsNodeMxcLimitedBadge")
                }}</span>
              </div>
              <p>{{ t("settings.windowsNodeMxcModeLimitedDesc") }}</p>
              <p class="mxc-mode-warning">
                {{ t("settings.windowsNodeMxcLimitedFilesystemWarning") }}
              </p>
              <p
                v-if="windowsNodeMxcStatus.limitedAvailability.summary"
                class="mxc-availability-summary"
              >
                {{ windowsNodeMxcStatus.limitedAvailability.summary }}
              </p>
              <ul
                v-if="
                  windowsNodeMxcStatus.limitedAvailability.blockers.length ||
                  windowsNodeMxcStatus.limitedAvailability.remediation.length
                "
                class="mxc-availability-list"
              >
                <li
                  v-for="blocker in windowsNodeMxcStatus.limitedAvailability.blockers"
                  :key="`limited-blocker-${blocker}`"
                  class="mxc-availability-blocker"
                >
                  {{ blocker }}
                </li>
                <li
                  v-for="step in windowsNodeMxcStatus.limitedAvailability.remediation"
                  :key="`limited-remediation-${step}`"
                >
                  {{ step }}
                </li>
              </ul>
              <el-button
                type="warning"
                plain
                data-testid="mxc-select-limited"
                :loading="windowsNodeMxcApplying"
                :disabled="
                  windowsNodeMxcApplying ||
                  !windowsNodeMxcStatus.limitedAvailability.available ||
                  windowsNodeMxcStatus.requestedMode === 'limited-dacl'
                "
                @click="selectWindowsNodeMxcMode('limited-dacl')"
              >
                {{
                  windowsNodeMxcStatus.requestedMode === "limited-dacl"
                    ? t("settings.windowsNodeMxcSelected")
                    : t("settings.windowsNodeMxcUseLimited")
                }}
              </el-button>
            </section>
            <section
              class="mxc-mode-card mxc-mode-card-off"
              :class="{ selected: windowsNodeMxcStatus.requestedMode === 'off' }"
              data-testid="mxc-mode-off"
            >
              <div class="mxc-mode-card-heading">
                <strong>{{ t("settings.windowsNodeMxcModeOff") }}</strong>
              </div>
              <p>{{ t("settings.windowsNodeMxcModeOffDesc") }}</p>
              <p class="mxc-mode-warning">{{ t("settings.windowsNodeMxcOffWarning") }}</p>
              <el-button
                plain
                data-testid="mxc-select-off"
                :loading="windowsNodeMxcApplying"
                :disabled="windowsNodeMxcApplying || windowsNodeMxcStatus.requestedMode === 'off'"
                @click="selectWindowsNodeMxcMode('off')"
              >
                {{
                  windowsNodeMxcStatus.requestedMode === "off"
                    ? t("settings.windowsNodeMxcSelected")
                    : t("settings.windowsNodeMxcUseOff")
                }}
              </el-button>
            </section>
          </div>
          <template v-if="windowsNodeMxcStatus">
            <div class="card-row mxc-status-summary" data-testid="mxc-status-summary">
              <span class="mxc-state" :class="windowsNodeMxcProtectionClass">
                {{ windowsNodeMxcCompactStatus }}
              </span>
            </div>
            <div v-if="windowsNodeMxcProtectionDetail" class="mxc-primary-detail">
              {{ windowsNodeMxcProtectionDetail }}
            </div>
            <div
              v-if="windowsNodeMxcHooksPausedSummary"
              class="mxc-alert mxc-alert-warning"
              data-testid="mxc-hooks-paused"
            >
              {{ windowsNodeMxcHooksPausedSummary }}
            </div>
            <div
              v-if="windowsNodeMxcStatus.canvas.state !== 'off'"
              class="mxc-alert"
              :class="
                windowsNodeMxcStatus.canvas.state === 'active'
                  ? 'mxc-alert-success'
                  : 'mxc-alert-warning'
              "
              data-testid="mxc-canvas-status"
            >
              {{
                windowsNodeMxcStatus.canvas.state === "active"
                  ? t("settings.windowsNodeMxcCanvasActive")
                  : t("settings.windowsNodeMxcCanvasPaused")
              }}
            </div>
            <div
              v-if="
                windowsNodeMxcStatus.requestedMode === 'limited-dacl' ||
                windowsNodeMxcStatus.effectiveStrength === 'limited-dacl'
              "
              class="card-row no-border mxc-ambient-compact"
              :class="windowsNodeMxcAmbientSummaryClass"
              data-testid="mxc-ambient-compact"
            >
              {{ windowsNodeMxcAmbientSummary }}
            </div>
            <div
              class="card-row no-border mxc-folder-policy"
              style="flex-direction: column; align-items: stretch"
            >
              <span class="row-label">{{ windowsNodeMxcFolderTitle }}</span>
              <div class="mxc-folder-policy-hint">
                {{ windowsNodeMxcFolderHint }}
              </div>
              <div
                v-if="windowsNodeMxcStatus.requestedMode !== 'off'"
                class="mxc-alert mxc-alert-warning mxc-folder-policy-locked"
              >
                {{ t("settings.windowsNodeMxcFoldersStaged") }}
              </div>
              <div
                v-if="windowsNodeMxcStatus.folderPolicyRecovery?.lastError"
                class="mxc-alert mxc-alert-error"
              >
                {{ t("settings.windowsNodeMxcFolderRecovery") }}:
                <strong v-if="windowsNodeMxcStatus.folderPolicyRecovery.failurePhase">
                  {{ windowsNodeMxcStatus.folderPolicyRecovery.failurePhase }}:
                </strong>
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
                  <span class="dir-badge dir-badge-rw">{{
                    t("settings.windowsNodeMxcGrantReadWrite")
                  }}</span>
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
                  <span class="dir-badge dir-badge-ro">{{
                    t("settings.windowsNodeMxcGrantReadOnly")
                  }}</span>
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
              v-if="!windowsNodeMxcLimitedMode"
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
            <div
              v-else
              class="card-row no-border mxc-folder-policy"
              style="flex-direction: column; align-items: stretch"
              data-testid="mxc-limited-approvals"
            >
              <span class="row-label">{{
                t("settings.windowsNodeMxcLimitedCommandApprovals")
              }}</span>
              <div class="mxc-alert mxc-alert-warning">
                {{ t("settings.windowsNodeMxcLimitedCommandApprovalsHint") }}
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
                <span class="row-label">{{ t("settings.windowsNodeMxcRequestedMode") }}</span>
                <span class="row-value">{{ windowsNodeMxcRequestedModeLabel }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcAttestedStrength") }}</span>
                <span class="row-value">{{ windowsNodeMxcEffectiveStrengthLabel }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcAttestedTier") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.effectiveTier ?? t("settings.windowsNodeMxcUnavailable")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcEffective") }}</span>
                <span class="row-value">{{ windowsNodeMxcProtectionLabel }}</span>
              </div>
              <div
                v-if="windowsNodeMxcLimitedMode"
                class="card-row mxc-ambient-diagnostics"
                data-testid="mxc-ambient-diagnostics"
              >
                <span class="row-label">{{ t("settings.windowsNodeMxcAmbientBeforeGrants") }}</span>
                <template v-if="windowsNodeMxcStatus.ambientAccess">
                  <div class="mxc-ambient-grid">
                    <span
                      v-for="entry in windowsNodeMxcStatus.ambientAccess.entries"
                      :key="entry.category"
                      class="mxc-ambient-entry"
                    >
                      <span>{{ windowsNodeMxcAmbientCategoryLabel(entry.category) }}</span>
                      <strong :class="`mxc-ambient-status-${entry.status}`">{{
                        windowsNodeMxcAmbientStatusLabel(entry.status)
                      }}</strong>
                    </span>
                  </div>
                  <div class="mxc-ambient-metadata">
                    <span>
                      {{ t("settings.windowsNodeMxcAmbientContract") }}:
                      {{ windowsNodeMxcStatus.ambientAccess.contract }}
                    </span>
                    <span>
                      {{ t("settings.windowsNodeMxcAmbientHash") }}:
                      {{ windowsNodeMxcStatus.ambientAccess.hash }}
                    </span>
                    <span>
                      {{ t("settings.windowsNodeMxcAmbientCheckedAt") }}:
                      {{ windowsNodeMxcStatus.ambientAccess.checkedAt }}
                    </span>
                  </div>
                </template>
                <div v-else class="mxc-alert mxc-alert-warning">
                  {{ t("settings.windowsNodeMxcAmbientUnavailable") }}
                </div>
                <div class="mxc-folder-policy-hint">
                  {{ t("settings.windowsNodeMxcAmbientAccessHint") }}
                </div>
              </div>
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
                <span class="row-label">{{ t("settings.windowsNodeMxcBaseContainerApi") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.probe.probes.baseContainerApiPresent === null
                    ? t("settings.windowsNodeMxcUnknown")
                    : windowsNodeMxcStatus.probe.probes.baseContainerApiPresent
                      ? t("settings.windowsNodeMxcAvailable")
                      : t("settings.windowsNodeMxcMissing")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcBfsRuntime") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.probe.probes.bfsCompiledIn === null
                    ? t("settings.windowsNodeMxcUnknown")
                    : windowsNodeMxcStatus.probe.probes.bfsCompiledIn
                      ? t("settings.windowsNodeMxcCompiledIn")
                      : t("settings.windowsNodeMxcCompiledOut")
                }}</span>
              </div>
              <div class="card-row">
                <span class="row-label">{{ t("settings.windowsNodeMxcBfsHostTool") }}</span>
                <span class="row-value">{{
                  windowsNodeMxcStatus.probe.probes.bfscfgPresent === null
                    ? t("settings.windowsNodeMxcUnknown")
                    : windowsNodeMxcStatus.probe.probes.bfscfgPresent
                      ? t("settings.windowsNodeMxcAvailable")
                      : t("settings.windowsNodeMxcMissing")
                }}</span>
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
                      ? `${windowsNodeMxcStatus.smoke.profile}: ${windowsNodeMxcStatus.smoke.execution.outcome}${
                          windowsNodeMxcStatus.smoke.deniedOutsideRoot
                            ? ` / outside-root ${windowsNodeMxcStatus.smoke.deniedOutsideRoot.outcome}`
                            : ""
                        }`
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
          v-if="windowsNodeMxcStatus?.requestedMode === 'off'"
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
          v-if="windowsNodeMxcStatus?.requestedMode === 'off'"
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
            <span
              class="row-value"
              style="
                text-align: left;
                max-width: none;
                font-family: &quot;Cascadia Code&quot;, &quot;Fira Code&quot;, Consolas, monospace;
                font-size: 12px;
                color: var(--text-secondary);
              "
            >
              {{ t("settings.sensitiveFilePatterns") }}
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
      <div v-if="activeSection === 'about'" class="section">
        <div class="section-label">{{ t("settings.about") }}</div>
        <div class="about-card">
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
        <div class="card-group" style="margin-top: 16px">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.copyright") }}</span>
            <span class="row-value">© 2026 {{ t("app.name") }}</span>
          </div>
        </div>
        <div class="sub-label">{{ t("settings.legal") }}</div>
        <div class="card-group legal-links">
          <a class="card-row legal-link" :href="eulaUrl" @click.prevent="openExternal(eulaUrl)">
            {{ t("settings.eula") }}
          </a>
          <a
            class="card-row legal-link no-border"
            :href="privacyStatementUrl"
            @click.prevent="openExternal(privacyStatementUrl)"
          >
            {{ t("settings.privacyStatement") }}
          </a>
        </div>
      </div>
      <MxcCapabilityConsentDialog
        v-model="windowsNodeMxcConsentVisible"
        :target-mode="windowsNodeMxcConsentTarget"
        :submitting="windowsNodeMxcConsentSubmitting"
        @accept="acceptWindowsNodeMxcCapabilityConsent"
        @cancel="cancelWindowsNodeMxcCapabilityConsent"
      />
      <el-dialog
        v-model="windowsNodeMxcLimitedAcknowledgementVisible"
        :title="t('settings.windowsNodeMxcLimitedAcknowledgeTitle')"
        width="560"
        :close-on-click-modal="!windowsNodeMxcApplying"
        :close-on-press-escape="!windowsNodeMxcApplying"
        :show-close="!windowsNodeMxcApplying"
      >
        <p class="mxc-limited-dialog-warning">
          {{ t("settings.windowsNodeMxcLimitedAcknowledgeBody") }}
        </p>
        <label class="mxc-limited-checkbox">
          <input
            v-model="windowsNodeMxcLimitedAcknowledged"
            type="checkbox"
            data-testid="mxc-limited-ack-checkbox"
            :disabled="windowsNodeMxcApplying"
          />
          <span>{{ t("settings.windowsNodeMxcLimitedAcknowledgeCheckbox") }}</span>
        </label>
        <template #footer>
          <el-button
            :disabled="windowsNodeMxcApplying"
            @click="windowsNodeMxcLimitedAcknowledgementVisible = false"
          >
            {{ t("common.cancel") }}
          </el-button>
          <el-button
            type="warning"
            data-testid="mxc-confirm-limited"
            :loading="windowsNodeMxcApplying"
            :disabled="!windowsNodeMxcLimitedAcknowledged"
            @click="confirmWindowsNodeMxcLimitedMode"
          >
            {{ t("settings.windowsNodeMxcEnableLimited") }}
          </el-button>
        </template>
      </el-dialog>
      <MxcWeixinRemoteApprovalDialog
        v-model="windowsNodeMxcWeixinRemoteApprovalVisible"
        :options="windowsNodeMxcWeixinRemoteApprovalOptions"
        :submitting="windowsNodeMxcApplying"
        @confirm="confirmWindowsNodeMxcWeixinRemoteApproval"
        @cancel="cancelWindowsNodeMxcWeixinRemoteApproval"
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
import { getLocale, t, setLocale } from "@/i18n";
import type { Locale } from "@/i18n";
import ModelSetupDialog from "@/components/ModelSetupDialog.vue";
import MxcCapabilityConsentDialog from "@/components/MxcCapabilityConsentDialog.vue";
import MxcWeixinRemoteApprovalDialog from "@/components/MxcWeixinRemoteApprovalDialog.vue";
import type { WindowsNodeMxcDisclosureTargetMode } from "../../../src/windows-node-mxc-disclosure";
import LocalModelSetupDialog from "@/components/LocalModelSetupDialog.vue";
import LocalModelDownloadDialog from "@/components/LocalModelDownloadDialog.vue";
import SessionModelRecoveryNotice from "@/components/SessionModelRecoveryNotice.vue";
import type { SessionModelRecovery } from "../../../src/session-model-types";
import DefaultModelPicker from "@/components/DefaultModelPicker.vue";
import { mergeLocalModelCatalog } from "@/utils/local-model-catalog";
import { isManagedLocalModel, type LocalModelCatalogEntry } from "../../../src/local-model-catalog";
import { useLocalModelOperation } from "@/composables/use-local-model-operation";
import { confirmLocalModelSwitch, releaseLocalModelSetup } from "@/utils/local-model-transition";
import { getDefaultAgentModelOverride, removeModelProviderConfig } from "@/utils/model-provider";
import {
  mergeGitHubCopilotModelEntries,
  removeGitHubCopilotModelReferences,
} from "@/utils/auth-managed-models";
import { MANAGED_MODEL_PROVIDERS, getManagedModelProvider } from "@/utils/managed-model-providers";
import {
  useProviderModelCatalog,
  readConfiguredCatalogs,
  type ConfiguredCatalogs,
} from "@/composables/use-provider-model-catalog";
import {
  readConfiguredModels,
  getModelRef,
  providerName,
  type ConfiguredModel,
} from "@/utils/configured-models";
import type { LocalModelFileStatus } from "../../../src/local-model-types";
import {
  hydratePrivacyControls,
  type PrivacyControls,
  type PrivacyLevel,
} from "@/utils/privacy-settings";
const route = useRoute();
const gateway = useGatewayStore();
const chatStore = useChatStore();
const { operation: localOperation, refresh: refreshLocalOperation } = useLocalModelOperation();
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
type WindowsNodeMxcMode = WindowsNodeMxcStatus["requestedMode"];
type WeixinRemoteApprovalActivationOptions = Awaited<
  ReturnType<typeof window.openclaw.windowsNodeMxc.getWeixinRemoteApprovalActivationOptions>
>;
type WeixinRemoteApprovalActivationSelection =
  | { enabled: false }
  | {
      enabled: true;
      owner: WeixinRemoteApprovalActivationOptions["eligibleOwners"][number];
    };
type WindowsNodeMxcAmbientEntry = NonNullable<
  WindowsNodeMxcStatus["ambientAccess"]
>["entries"][number];
const windowsNodeMxcStatus = ref<WindowsNodeMxcStatus | null>(null);
const windowsNodeMxcApplying = ref(false);
const windowsNodeMxcFolderApplying = ref(false);
const windowsNodeMxcTechnicalDetailsOpen = ref(false);
const windowsNodeMxcConsentVisible = ref(false);
const windowsNodeMxcConsentTarget = ref<WindowsNodeMxcDisclosureTargetMode | null>(null);
const windowsNodeMxcConsentSubmitting = ref(false);
const windowsNodeMxcLimitedAcknowledgementVisible = ref(false);
const windowsNodeMxcLimitedAcknowledged = ref(false);
const windowsNodeMxcWeixinRemoteApprovalVisible = ref(false);
const windowsNodeMxcWeixinRemoteApprovalOptions =
  ref<WeixinRemoteApprovalActivationOptions | null>(null);
const windowsNodeMxcPendingActivation = ref<{
  requestedMode: Exclude<WindowsNodeMxcMode, "off">;
  acknowledgeLimitedFilesystem: boolean;
} | null>(null);
const windowsNodeMxcTransitionPhases = new Set([
  "locking",
  "validating",
  "persisting",
  "starting-locked",
  "smoking-locked",
  "starting-active",
  "smoking-active",
  "promoting-active",
  "verifying-active",
  "starting-standard",
]);

const windowsNodeMxcProtectionLabel = computed(() => {
  const status = windowsNodeMxcStatus.value;
  if (!status || status.requestedMode === "off") {
    return t("settings.windowsNodeMxcProtectionOff");
  }
  if (status.effectiveEnabled && status.lifecycleState.phase === "active") {
    if (status.effectiveStrength === "limited-dacl") {
      return t("settings.windowsNodeMxcLimitedActive");
    }
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
  return status?.requestedMode !== "off" ? "mxc-state-blocked" : "mxc-state-neutral";
});

const windowsNodeMxcProtectionDetail = computed(() => {
  const status = windowsNodeMxcStatus.value;
  if (
    !status ||
    status.requestedMode === "off" ||
    (status.effectiveEnabled && status.lifecycleState.phase === "active")
  ) {
    return "";
  }
  const phase = t(`settings.windowsNodeMxcLifecyclePhase.${status.lifecycleState.phase}`);
  return status.lifecycleState.detail ? `${phase} · ${status.lifecycleState.detail}` : phase;
});

const windowsNodeMxcHooksPausedSummary = computed(() => {
  const hooks = windowsNodeMxcStatus.value?.hooks;
  if (!hooks?.pausedByMxc) return "";
  if (hooks.requestedExternalEnabled && hooks.requestedInternalEnabled) {
    return t("settings.windowsNodeMxcHooksPausedBoth");
  }
  return hooks.requestedExternalEnabled
    ? t("settings.windowsNodeMxcHooksPausedExternal")
    : t("settings.windowsNodeMxcHooksPausedInternal");
});

const windowsNodeMxcLimitedMode = computed(() => {
  const status = windowsNodeMxcStatus.value;
  return status?.requestedMode === "limited-dacl" || status?.effectiveStrength === "limited-dacl";
});

const windowsNodeMxcRequestedModeLabel = computed(() =>
  windowsNodeMxcModeLabel(windowsNodeMxcStatus.value?.requestedMode ?? "off"),
);

const windowsNodeMxcEffectiveStrengthLabel = computed(() =>
  windowsNodeMxcModeLabel(windowsNodeMxcStatus.value?.effectiveStrength ?? "off"),
);

const windowsNodeMxcCompactStatus = computed(() => {
  const status = windowsNodeMxcStatus.value;
  if (!status || status.requestedMode === "off") {
    return t("settings.windowsNodeMxcCompactOff");
  }
  const mode =
    status.effectiveEnabled && status.lifecycleState.phase === "active"
      ? windowsNodeMxcModeLabel(status.effectiveStrength)
      : windowsNodeMxcModeLabel(status.requestedMode);
  const state =
    status.effectiveEnabled && status.lifecycleState.phase === "active"
      ? t("settings.windowsNodeMxcStatusActive")
      : windowsNodeMxcTransitionPhases.has(status.lifecycleState.phase)
        ? t("settings.windowsNodeMxcStarting")
        : t("settings.windowsNodeMxcActionRequired");
  return t("settings.windowsNodeMxcCompactStatus", { mode, state });
});

const windowsNodeMxcAmbientEntries = computed(
  () => windowsNodeMxcStatus.value?.ambientAccess?.entries ?? [],
);

const windowsNodeMxcAmbientExceptions = computed(() =>
  windowsNodeMxcAmbientEntries.value.filter((entry) => entry.status !== "denied"),
);

const windowsNodeMxcAmbientSummary = computed(() => {
  const entries = windowsNodeMxcAmbientEntries.value;
  if (entries.length === 0) {
    return t("settings.windowsNodeMxcAmbientUnavailable");
  }
  const denied = entries.length - windowsNodeMxcAmbientExceptions.value.length;
  if (windowsNodeMxcAmbientExceptions.value.length === 0) {
    return t("settings.windowsNodeMxcAmbientAllDenied", {
      denied,
      total: entries.length,
    });
  }
  const details = windowsNodeMxcAmbientExceptions.value
    .map(
      (entry) =>
        `${windowsNodeMxcAmbientCategoryLabel(entry.category)} — ${windowsNodeMxcAmbientStatusLabel(entry.status)}`,
    )
    .join(", ");
  return t("settings.windowsNodeMxcAmbientExceptions", {
    details,
    denied,
    total: entries.length,
  });
});

const windowsNodeMxcAmbientSummaryClass = computed(() => {
  if (windowsNodeMxcAmbientEntries.value.length === 0) {
    return "mxc-summary-warning";
  }
  return windowsNodeMxcAmbientExceptions.value.length === 0
    ? "mxc-summary-ok"
    : "mxc-summary-error";
});

const windowsNodeMxcFolderTitle = computed(() => {
  if (windowsNodeMxcLimitedMode.value) {
    return t("settings.windowsNodeMxcLimitedFolders");
  }
  if (windowsNodeMxcStatus.value?.requestedMode === "off") {
    return t("settings.windowsNodeMxcConfiguredFolders");
  }
  return t("settings.windowsNodeMxcFullFolders");
});

const windowsNodeMxcFolderHint = computed(() => {
  if (windowsNodeMxcLimitedMode.value) {
    return t("settings.windowsNodeMxcLimitedFoldersHint");
  }
  if (windowsNodeMxcStatus.value?.requestedMode === "off") {
    return t("settings.windowsNodeMxcConfiguredFoldersHint");
  }
  return t("settings.windowsNodeMxcFoldersHint");
});

function windowsNodeMxcModeLabel(mode: WindowsNodeMxcMode) {
  if (mode === "full") return t("settings.windowsNodeMxcModeFull");
  if (mode === "limited-dacl") return t("settings.windowsNodeMxcModeLimited");
  return t("settings.windowsNodeMxcModeOff");
}

function windowsNodeMxcAmbientCategoryLabel(category: WindowsNodeMxcAmbientEntry["category"]) {
  return t(`settings.windowsNodeMxcAmbientCategory.${category}`);
}

function windowsNodeMxcAmbientStatusLabel(status: WindowsNodeMxcAmbientEntry["status"]) {
  return t(`settings.windowsNodeMxcAmbientStatus.${status}`);
}

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

function selectWindowsNodeMxcMode(mode: WindowsNodeMxcMode) {
  if (
    windowsNodeMxcApplying.value ||
    windowsNodeMxcConsentVisible.value ||
    windowsNodeMxcLimitedAcknowledgementVisible.value ||
    windowsNodeMxcWeixinRemoteApprovalVisible.value ||
    windowsNodeMxcStatus.value?.requestedMode === mode
  ) {
    return;
  }
  if (mode === "off") {
    void applyWindowsNodeMxcMode(mode);
    return;
  }
  windowsNodeMxcConsentTarget.value = mode;
  windowsNodeMxcConsentVisible.value = true;
}

function cancelWindowsNodeMxcCapabilityConsent() {
  if (windowsNodeMxcConsentSubmitting.value) return;
  windowsNodeMxcConsentVisible.value = false;
  windowsNodeMxcConsentTarget.value = null;
}

async function acceptWindowsNodeMxcCapabilityConsent() {
  const requestedMode = windowsNodeMxcConsentTarget.value;
  if (!requestedMode || windowsNodeMxcConsentSubmitting.value) return;

  windowsNodeMxcConsentSubmitting.value = true;
  windowsNodeMxcConsentVisible.value = false;
  windowsNodeMxcConsentTarget.value = null;
  try {
    if (requestedMode === "limited-dacl") {
      windowsNodeMxcLimitedAcknowledged.value = false;
      windowsNodeMxcLimitedAcknowledgementVisible.value = true;
      return;
    }
    await beginWindowsNodeMxcActivation(requestedMode);
  } finally {
    windowsNodeMxcConsentSubmitting.value = false;
  }
}

async function confirmWindowsNodeMxcLimitedMode() {
  if (!windowsNodeMxcLimitedAcknowledged.value || windowsNodeMxcApplying.value) return;
  if (await beginWindowsNodeMxcActivation("limited-dacl", true)) {
    windowsNodeMxcLimitedAcknowledgementVisible.value = false;
  }
}

async function beginWindowsNodeMxcActivation(
  requestedMode: Exclude<WindowsNodeMxcMode, "off">,
  acknowledgeLimitedFilesystem = false,
): Promise<boolean> {
  if (windowsNodeMxcStatus.value?.requestedMode !== "off") {
    return applyWindowsNodeMxcMode(requestedMode, acknowledgeLimitedFilesystem);
  }
  try {
    const options =
      await window.openclaw.windowsNodeMxc.getWeixinRemoteApprovalActivationOptions();
    if (options.weixinEnabled && options.linkedAccountCount > 0) {
      windowsNodeMxcPendingActivation.value = {
        requestedMode,
        acknowledgeLimitedFilesystem,
      };
      windowsNodeMxcWeixinRemoteApprovalOptions.value = options;
      windowsNodeMxcWeixinRemoteApprovalVisible.value = true;
      return true;
    }
    return applyWindowsNodeMxcMode(requestedMode, acknowledgeLimitedFilesystem, {
      enabled: false,
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function cancelWindowsNodeMxcWeixinRemoteApproval() {
  if (windowsNodeMxcApplying.value) return;
  windowsNodeMxcWeixinRemoteApprovalVisible.value = false;
  windowsNodeMxcWeixinRemoteApprovalOptions.value = null;
  windowsNodeMxcPendingActivation.value = null;
}

async function confirmWindowsNodeMxcWeixinRemoteApproval(
  selection: WeixinRemoteApprovalActivationSelection,
) {
  const pending = windowsNodeMxcPendingActivation.value;
  if (!pending || windowsNodeMxcApplying.value) return;
  windowsNodeMxcWeixinRemoteApprovalVisible.value = false;
  const succeeded = await applyWindowsNodeMxcMode(
    pending.requestedMode,
    pending.acknowledgeLimitedFilesystem,
    selection,
  );
  windowsNodeMxcWeixinRemoteApprovalOptions.value = null;
  windowsNodeMxcPendingActivation.value = null;
  if (!succeeded) return;
}

async function applyWindowsNodeMxcMode(
  requestedMode: WindowsNodeMxcMode,
  acknowledgeLimitedFilesystem = false,
  remoteApproval?: WeixinRemoteApprovalActivationSelection,
): Promise<boolean> {
  windowsNodeMxcApplying.value = true;
  try {
    if (requestedMode !== "off") {
      await window.openclaw.windowsNodeMxc.preflight({ requestedMode });
    }
    gateway.resetReady();
    chatStore.wsConnected = false;
    const status = await window.openclaw.windowsNodeMxc.setEnabled({
      requestedMode,
      ...(requestedMode === "limited-dacl" ? { acknowledgeLimitedFilesystem } : {}),
      ...(remoteApproval ? { remoteApproval } : {}),
    });
    updateWindowsNodeMxcStatus(status);
    await loadSandboxStatus();
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
    await loadWindowsNodeMxcStatus();
    return false;
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
    if (windowsNodeMxcStatus.value?.requestedMode === "off") {
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
    if (windowsNodeMxcStatus.value?.requestedMode === "off") {
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
    if (windowsNodeMxcStatus.value?.requestedMode === "off") {
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
const customModels = ref<ConfiguredModel[]>([]);
const modelFormSelections = ref<Record<string, string>>({});
const selectedModel = ref("");
const copilotModelsLoading = ref(false);
const copilotDisconnecting = ref(false);
const switchingModelRef = ref("");
const removingModelRef = ref("");
let copilotModelsGeneration = 0;
const showProviderSetup = ref(false);
const editingProviderKey = ref("");
const editingModelRef = ref("");
const providerSaving = ref(false);
const modelStatusError = ref("");
const localFileStatus = ref(new Map<string, LocalModelFileStatus>());
const localCatalog = ref<LocalModelCatalogEntry[]>([]);
const localProviderReady = ref(false);
const localSelection = ref("");
const localSelecting = ref(false);
const sessionRecovery = ref<SessionModelRecovery | null>(null);
const sessionRecovering = ref(false);
const providerCatalog = useProviderModelCatalog();
const providerCatalogInputs = ref<ConfiguredCatalogs>({});
const providerCatalogLoading = ref(false);
let providerCatalogRevision = 0;
const providerCatalogError = computed(() => providerCatalog.errors(providerCatalogInputs.value));
const modelOptions = computed(() =>
  mergeLocalModelCatalog(
    providerCatalog.merge(customModels.value, providerCatalogInputs.value),
    localCatalog.value,
  ),
);
function modelOptionStatus(model: ConfiguredModel): string {
  const preset = localCatalog.value.find((entry) => entry.modelRef === getModelRef(model));
  if (preset && localOperation.value?.busy && localOperation.value.modelRef === preset.modelRef) {
    return t(
      localOperation.value.download && localOperation.value.step?.type !== "confirm"
        ? "fixedLocal.downloading"
        : "fixedLocal.preparing",
    );
  }
  const status = preset
    ? t(
        preset.fileStatus === "external"
          ? "modelManager.external"
          : preset.fileStatus === "present"
            ? "modelManager.downloaded"
            : preset.fileStatus === "unknown"
              ? "localModel.filesUnknown"
              : "fixedLocal.notDownloaded",
      )
    : localFileStatus.value.get(getModelRef(model)) === "missing"
      ? t("localModel.filesMissing")
      : "";
  return status;
}
let localSnapshotRevision = 0;
const providerCards = computed(() => {
  const keys = new Set([
    "github-copilot",
    ...MANAGED_MODEL_PROVIDERS.map((provider) => provider.id),
    "llama-cpp",
    ...customModels.value.map((model) => model.providerKey),
  ]);
  return [...keys].map((key) => {
    const models = customModels.value.filter((model) => model.providerKey === key);
    return {
      key,
      label:
        key === "llama-cpp"
          ? t("localModel.title")
          : key === "custom"
            ? t("modelManager.compatibleApi")
            : providerName(key),
      models,
      signupUrl: getManagedModelProvider(key)?.signupUrl ?? "",
      editableModels: key === "github-copilot" || getManagedModelProvider(key) ? [] : models,
      missing: models.some((model) => localFileStatus.value.get(getModelRef(model)) === "missing"),
    };
  });
});
const editingFamily = computed(
  () =>
    getManagedModelProvider(editingProviderKey.value)?.id ??
    (editingProviderKey.value === "github-copilot" ? "github-copilot" : "custom"),
);
const providerPrefill = computed(() => {
  const model = customModels.value.find((item) => getModelRef(item) === editingModelRef.value);
  if (!model) return null;
  return {
    familyId: editingFamily.value,
    providerKey: model.providerKey,
    modelName: model.id,
    displayName: model.name,
    baseUrl: model.baseUrl ?? "",
    apiKey: model.apiKey ?? "",
    apiFormat: model.apiFormat ?? ("openai-chat" as const),
    reasoningEffort: model.reasoningEffort,
    input: model.input,
  };
});
const showLocalSetup = ref(false);
const localTargetModel = ref<string>();
const defaultAgentOverride = ref<ReturnType<typeof getDefaultAgentModelOverride>>(null);
const removableLocalConnections = computed(() =>
  customModels.value
    .filter(
      (model) =>
        model.providerKey === "llama-cpp" &&
        getModelRef(model) !== selectedModel.value &&
        getModelRef(model) !== defaultAgentOverride.value?.modelRef,
    )
    .map((model) => ({ modelRef: getModelRef(model), name: model.name })),
);
const cloudTransition = ref(false);
let modelViewDisposed = false;
const modelActionBusy = computed(() =>
  Boolean(
    switchingModelRef.value ||
    removingModelRef.value ||
    copilotDisconnecting.value ||
    cloudTransition.value ||
    providerSaving.value ||
    sessionRecovering.value ||
    localSelecting.value,
  ),
);
const modelMutationBlocked = computed(() =>
  Boolean(
    switchingModelRef.value ||
    removingModelRef.value ||
    copilotDisconnecting.value ||
    cloudTransition.value ||
    providerSaving.value ||
    sessionRecovery.value ||
    sessionRecovering.value ||
    localSelecting.value ||
    chatStore.streaming ||
    localOperation.value?.busy,
  ),
);
function openLocalModel(modelRef?: string) {
  if (modelActionBusy.value) return;
  localTargetModel.value = modelRef;
  showLocalSetup.value = true;
}

async function prepareCloudChange(): Promise<boolean> {
  cloudTransition.value = true;
  try {
    const release = await releaseLocalModelSetup(
      window.openclaw.model.local,
      confirmLocalModelSwitch,
      () => !modelViewDisposed,
    );
    await refreshLocalOperation();
    if (release === "pending") {
      ElMessage.info(t("localModel.setupFinishing"));
      showLocalSetup.value = true;
      return false;
    }
    return release === "ready" && !modelViewDisposed;
  } finally {
    cloudTransition.value = false;
  }
}

function isProviderExpanded(key: string): boolean {
  return key === "llama-cpp"
    ? showLocalSetup.value
    : showProviderSetup.value && editingProviderKey.value === key;
}

function toggleProvider(key: string): void {
  if (modelActionBusy.value) return;
  if (isProviderExpanded(key)) {
    if (key === "llama-cpp") showLocalSetup.value = false;
    else showProviderSetup.value = false;
  } else if (key === "llama-cpp") openLocalModel();
  else openCloudSetup(key);
}

function openCloudSetup(providerKey: string, model?: ConfiguredModel): void {
  if (modelActionBusy.value) return;
  editingProviderKey.value = providerKey;
  const entry =
    model ??
    customModels.value.find(
      (item) =>
        item.providerKey === providerKey &&
        getModelRef(item) === modelFormSelections.value[providerKey],
    ) ??
    customModels.value.find((item) => item.providerKey === providerKey);
  editingModelRef.value = entry ? getModelRef(entry) : `new:${providerKey}`;
  showProviderSetup.value = true;
}
watch(
  () => route.query?.provider,
  (provider) => {
    if (provider === "llama-cpp") openLocalModel();
  },
  { immediate: true },
);

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
  defaultAgentOverride.value = getDefaultAgentModelOverride(config);
  const parsed = readConfiguredModels(config);
  customModels.value = parsed.models;
  selectedModel.value = parsed.primary;
  providerCatalogInputs.value = readConfiguredCatalogs(config);
  const revision = ++providerCatalogRevision;
  providerCatalogLoading.value = true;
  void providerCatalog.loadConfigured(providerCatalogInputs.value).finally(() => {
    if (!modelViewDisposed && revision === providerCatalogRevision)
      providerCatalogLoading.value = false;
  });
  void loadLocalFileStatus();
}

async function loadLocalFileStatus(): Promise<void> {
  const revision = ++localSnapshotRevision;
  localFileStatus.value = new Map();
  localProviderReady.value = false;
  try {
    const [result, capabilities] = await Promise.all([
      window.openclaw.model.local.getSnapshot(),
      window.openclaw.model.local.getCapabilities(),
    ]);
    if (modelViewDisposed || revision !== localSnapshotRevision) return;
    if (!result.ok) throw new Error(result.error);
    localCatalog.value = result.value.catalog ?? [];
    localFileStatus.value = new Map(
      result.value.models.map((model) => [model.modelRef, model.fileStatus ?? "unknown"]),
    );
    if (!capabilities.ok) throw new Error(capabilities.error);
    localProviderReady.value =
      capabilities.value.supported &&
      capabilities.value.plugin.installed &&
      capabilities.value.plugin.enabled;
  } catch (error) {
    if (!modelViewDisposed && revision === localSnapshotRevision)
      modelStatusError.value = error instanceof Error ? error.message : String(error);
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
    modelStatusError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === copilotModelsGeneration) copilotModelsLoading.value = false;
  }
}

async function refreshModelsConfig(): Promise<void> {
  try {
    modelStatusError.value = "";
    const [config, saved] = await Promise.all([
      window.openclaw.config.read(),
      window.openclaw.settings.get(),
    ]);
    modelFormSelections.value = saved?.modelFormSelections ?? {};
    if (!config) return;
    applyModelsConfig(config);
    void loadSettingsGitHubCopilotModels();
  } catch (error) {
    console.warn("[settings] Failed to refresh model configuration:", error);
    modelStatusError.value = error instanceof Error ? error.message : String(error);
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
  if (wasVisible && !visible) {
    editingProviderKey.value = "";
    void refreshModelsConfig();
  }
});
watch(showLocalSetup, (visible, wasVisible) => {
  if (wasVisible && !visible) void refreshModelsConfig();
});

onMounted(async () => {
  window.addEventListener("focus", handleSettingsWindowFocus);
  // Load persisted app settings
  const saved = await window.openclaw.settings.get();
  if (saved) {
    modelFormSelections.value = saved.modelFormSelections ?? {};
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
  localSnapshotRevision += 1;
  providerCatalogRevision += 1;
  modelViewDisposed = true;
});

// --- Model & Gateway actions ---

async function handleProviderConfigured(): Promise<void> {
  await refreshModelsConfig();
  ElMessage.success(t("settings.providerConfigured"));
}

async function handleLocalModelSelected(): Promise<void> {
  const model = localSelection.value;
  await refreshModelsConfig();
  ElMessage.success(t("settings.modelSwitched", { model }));
}

async function restartGatewayAfterModelConfig(
  options: { waitForRendererReconnect?: boolean } = {},
): Promise<void> {
  await window.openclaw.gateway.restart();
  if (options.waitForRendererReconnect !== false) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function selectModel(modelRef: string) {
  if (modelActionBusy.value || chatStore.streaming || sessionRecovery.value) return;
  if (!modelOptions.value.some((model) => getModelRef(model) === modelRef)) {
    ElMessage.error(t("settings.configSaveFailed", { error: `Unknown model "${modelRef}"` }));
    return;
  }
  if (modelRef.startsWith("llama-cpp/")) {
    if (isManagedLocalModel(modelRef)) {
      if (!localProviderReady.value) {
        openLocalModel();
        return;
      }
      localSelection.value = modelRef;
      return;
    }
    openLocalModel(modelRef);
    return;
  }
  try {
    if (!(await prepareCloudChange())) return;
    switchingModelRef.value = modelRef;
    const expectedConfig = await window.openclaw.config.read();
    if (chatStore.streaming || localOperation.value?.busy)
      throw new Error(t("localModel.operationBusy"));
    const selected = await window.openclaw.model.selectDefault({ modelRef, expectedConfig });
    if (selected.modelRef !== modelRef)
      throw new Error("The Gateway did not confirm the selected default model");
    await refreshModelsConfig();
    ElMessage.success(t("settings.modelSwitched", { model: modelRef }));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
    await refreshModelsConfig();
  } finally {
    switchingModelRef.value = "";
  }
}

async function removeCustomModel(idx: number) {
  if (modelMutationBlocked.value) return;
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
    const defaultSelector = existing.agents?.defaults?.model;
    const primary =
      typeof defaultSelector === "string" ? defaultSelector : defaultSelector?.primary;
    if (removed.providerKey === "llama-cpp" && primary === modelRef) {
      throw new Error(t("localModel.selectBeforeRemove"));
    }
    if (primary === modelRef && fallback?.providerKey === "llama-cpp") {
      throw new Error(t("localModel.selectBeforeRemove"));
    }
    if (chatStore.streaming || localOperation.value?.busy)
      throw new Error(t("localModel.operationBusy"));
    const nextConfig = removeModelProviderConfig(
      existing,
      removed.providerKey,
      removed.id,
      fallback ? getModelRef(fallback) : undefined,
    );
    await window.openclaw.config.write(nextConfig, existing);
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

async function removeLocalConnection(modelRef: string): Promise<void> {
  if (!removableLocalConnections.value.some((model) => model.modelRef === modelRef)) return;
  await removeCustomModel(customModels.value.findIndex((model) => getModelRef(model) === modelRef));
  if (!customModels.value.some((model) => getModelRef(model) === modelRef))
    showLocalSetup.value = false;
}

async function disconnectGitHubCopilot() {
  if (modelMutationBlocked.value) return;
  try {
    await ElMessageBox.confirm(t("settings.copilotDisconnectConfirm"), t("settings.confirm"), {
      type: "warning",
    });
  } catch {
    return;
  }
  if (modelMutationBlocked.value) return;

  const fallbackModel = customModels.value.find(
    (model) =>
      model.providerKey !== "github-copilot" &&
      model.providerKey !== "llama-cpp" &&
      model.source !== "auth-managed",
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
    await window.openclaw.config.write(nextConfig, existingConfig);

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

// Single save for the Web search section: commits both provider keys and the selected default
// provider in one action. The gateway hot-reloads the tools config on write.
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

async function openExternal(url: string) {
  try {
    await window.openclaw.shell.openExternal(url);
  } catch (error) {
    ElMessage.error(
      t("settings.openLinkFailed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

const privacyStatementUrl = "https://www.microsoft.com/privacy/privacystatement";
const eulaUrl = computed(() =>
  getLocale() === "zh-CN"
    ? "https://microclaw.microsoft.com/eula.html"
    : "https://microclaw.microsoft.com/eula.en.html",
);

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
.model-settings-section {
  max-width: 1040px;
}
.model-section-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
}
.provider-description {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 0 0 16px;
}
.provider-error {
  color: var(--el-color-danger);
  font-size: 13px;
}
.provider-cards {
  display: grid;
  gap: 10px;
  margin: 16px 0 28px;
}
.provider-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-fill-color-blank);
  overflow: hidden;
}
.provider-card-heading {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
}
.provider-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-primary);
  cursor: pointer;
}
.provider-toggle:hover {
  background: var(--el-fill-color-light);
}
.provider-toggle:focus-visible {
  outline: 2px solid var(--el-color-primary);
}
.provider-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.provider-chevron-up {
  transform: rotate(180deg);
}
.provider-card-title {
  flex: 1;
  min-width: 0;
}
.provider-card-title strong {
  font-size: 16px;
}
.provider-runtime {
  margin-left: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}
.provider-card-title p {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 6px 0 0;
}
.provider-state {
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
}
.provider-state.warning {
  color: var(--el-color-warning-dark-2);
}
.provider-editor {
  border-top: 1px solid var(--el-border-color-lighter);
}
.provider-model-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 10px 24px;
  font-size: 13px;
}
.provider-model-row > span:first-child {
  flex: 1;
  overflow-wrap: anywhere;
}
.default-model-card {
  margin-bottom: 12px;
}
.model-search-selector {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.model-search-hint {
  color: var(--text-secondary);
  font-size: 13px;
}
@media (max-width: 700px) {
  .provider-card-heading {
    gap: 8px;
    padding: 14px;
    flex-wrap: wrap;
  }
  .provider-card-title {
    flex-basis: 60%;
  }
}
.local-setup-status {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 4px 20px;
  color: var(--smtc-foreground-ctrl-neutral-secondary-rest, #666);
  font-size: 13px;
}

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
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-input);
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
.about-card {
  background: var(--bg-grouped);
  border-radius: 12px;
  border: 1px solid var(--border);
  padding: 28px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
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

.legal-links {
  margin-top: 0;
}

.legal-link {
  color: var(--el-color-primary);
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
}

.legal-link:hover {
  text-decoration: underline;
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
.mxc-heading {
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--border-row);
}
.mxc-subtitle {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 12px;
}
.mxc-mode-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-row);
}
.mxc-mode-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-secondary);
}
.mxc-mode-card.selected {
  border-color: color-mix(in srgb, var(--accent-color) 70%, var(--border));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-color) 35%, transparent);
}
.mxc-mode-card-limited {
  border-color: rgba(230, 162, 60, 0.45);
}
.mxc-mode-card-off {
  border-color: color-mix(in srgb, var(--settings-action-danger) 35%, var(--border));
}
.mxc-mode-card-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.mxc-mode-card p,
.mxc-availability-list {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}
.mxc-mode-card .el-button {
  align-self: flex-start;
  margin-top: auto;
}
.mxc-mode-badge {
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--accent-subtle);
  color: var(--accent-color);
  font-size: 10px;
  font-weight: 700;
}
.mxc-mode-badge-warning {
  background: rgba(230, 162, 60, 0.12);
  color: #b26a00;
}
.mxc-mode-warning,
.mxc-availability-blocker {
  color: var(--settings-action-danger) !important;
}
.mxc-availability-summary {
  font-weight: 600;
}
.mxc-availability-list {
  padding-left: 18px;
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
.mxc-status-summary {
  justify-content: flex-start;
}
.mxc-status-summary .mxc-state {
  font-size: 14px;
}
.mxc-ambient-compact {
  display: block;
  padding: 12px 24px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
}
.mxc-summary-ok {
  color: #388e3c;
}
.mxc-summary-warning {
  color: #b26a00;
}
.mxc-summary-error {
  color: var(--settings-action-danger);
}
.mxc-ambient-diagnostics {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.mxc-ambient-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.mxc-ambient-entry {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}
.mxc-ambient-status-denied {
  color: #4caf50;
}
.mxc-ambient-status-read {
  color: #b26a00;
}
.mxc-ambient-status-read-write {
  color: var(--settings-action-danger);
}
.mxc-ambient-metadata {
  display: grid;
  gap: 4px;
  color: var(--text-muted);
  font-size: 11px;
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
.mxc-alert-success {
  border-color: rgba(103, 194, 58, 0.45);
  background: rgba(103, 194, 58, 0.08);
}
.mxc-alert-error {
  border-color: color-mix(in srgb, var(--settings-action-danger) 45%, transparent);
  background: color-mix(in srgb, var(--settings-action-danger) 8%, transparent);
}
.mxc-limited-dialog-warning {
  margin: 0 0 16px;
  color: var(--text-secondary);
  line-height: 1.55;
}
.mxc-limited-checkbox {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
}
.mxc-limited-checkbox input {
  margin-top: 3px;
}
@container (max-width: 760px) {
  .mxc-mode-grid {
    grid-template-columns: 1fr;
  }
  .mxc-ambient-grid {
    grid-template-columns: 1fr;
  }
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
