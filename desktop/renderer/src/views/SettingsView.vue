<template>
  <div class="settings-view">
    <!-- Left sidebar: icon grid nav -->
    <div class="settings-sidebar">
      <div class="settings-title">
        {{ t("settings.title") }}
      </div>
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
    <div class="settings-content">
      <!-- General -->
      <div v-if="activeSection === 'general'" class="section">
        <div class="section-label">{{ t("settings.application") }}</div>
        <div class="card-group">
          <div class="card-row">
            <span class="row-label">{{ t("settings.language") }}</span>
            <el-select v-model="settings.language" size="small" style="width: 140px">
              <el-option label="简体中文" value="zh-CN" />
              <el-option label="English" value="en-US" />
            </el-select>
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.autoStart") }}</span>
            <el-switch v-model="settings.autoStart" />
          </div>
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.startMinimized") }}</span>
            <el-switch v-model="settings.startMinimized" />
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
      </div>

      <!-- Usage -->
      <div v-if="activeSection === 'usage'" class="section">
        <div class="section-label">{{ t("settings.usage") }}</div>

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
              <span class="row-value usage-spend">${{ usageData.totalSpend.toFixed(4) }}</span>
            </div>
            <div v-if="usageData.maxBudget" class="card-row no-border">
              <span class="row-label">{{ t("settings.budget") }}</span>
              <div class="budget-bar-wrapper">
                <span class="row-value"
                  >${{ usageData.totalSpend.toFixed(2) }} / ${{
                    usageData.maxBudget.toFixed(2)
                  }}</span
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
                <span class="row-value usage-spend">${{ m.spend.toFixed(4) }}</span>
              </div>
            </div>
          </template>

          <div class="section-actions">
            <el-button size="small" @click="loadUsage" :loading="usageLoading">{{
              t("settings.refresh")
            }}</el-button>
          </div>
        </template>

        <div class="section-footer">{{ t("settings.usageFooter") }}</div>
      </div>

      <!-- Models -->
      <div v-if="activeSection === 'models'" class="section">
        <!-- Custom Models -->
        <div class="sub-label-row">
          <span class="sub-label" style="margin-bottom: 0">{{ t("settings.customModels") }}</span>
          <el-button size="small" @click="showAddModel = true">{{
            t("settings.addCustomModel")
          }}</el-button>
        </div>
        <div class="card-group">
          <template v-if="customModels.length">
            <div
              v-for="(m, idx) in customModels"
              :key="m.id"
              class="card-row"
              :class="{ 'no-border': idx === customModels.length - 1 }"
            >
              <div class="custom-model-info">
                <span class="row-label">{{ m.name }}</span>
                <span class="row-sub">{{ describeCustomModel(m) }}</span>
              </div>
              <div class="custom-model-actions">
                <span v-if="m.id === selectedModel" class="badge badge-green">{{
                  t("settings.currentSelection")
                }}</span>
                <el-button v-else size="small" @click="selectModel(m.id)">{{
                  t("settings.select")
                }}</el-button>
                <el-button size="small" @click="editCustomModel(idx)">{{
                  t("settings.edit")
                }}</el-button>
                <el-button size="small" type="danger" plain @click="removeCustomModel(idx)">{{
                  t("settings.delete")
                }}</el-button>
              </div>
            </div>
          </template>
          <div v-else class="card-row no-border placeholder-row">
            <span class="placeholder-text">{{ t("settings.noCustomModels") }}</span>
          </div>
        </div>

        <!-- Add Custom Model dialog -->
        <el-dialog
          v-model="showAddModel"
          :title="t('settings.addCustomModel')"
          width="460px"
          :close-on-click-modal="false"
        >
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="t('settings.modelName')">
              <el-input v-model="newModel.name" placeholder="e.g. my-gpt-4o" />
            </el-form-item>
            <el-form-item :label="t('settings.baseUrl')">
              <el-input v-model="newModel.baseUrl" placeholder="https://api.example.com/v1" />
            </el-form-item>
            <el-form-item :label="t('settings.apiKey')">
              <el-input
                v-model="newModel.apiKey"
                type="password"
                show-password
                placeholder="sk-..."
              />
            </el-form-item>
            <el-form-item :label="t('settings.apiFormat')">
              <el-select v-model="newModel.apiFormat" style="width: 100%">
                <el-option :label="t('settings.apiFormatOpenAIChat')" value="openai-chat" />
                <el-option
                  :label="t('settings.apiFormatOpenAIResponses')"
                  value="openai-responses"
                />
                <el-option :label="t('settings.apiFormatAnthropic')" value="anthropic" />
              </el-select>
            </el-form-item>
            <el-form-item :label="t('settings.reasoningEffort')">
              <el-select v-model="newModel.reasoningEffort" style="width: 100%">
                <el-option
                  v-for="option in reasoningEffortOptions"
                  :key="option.value"
                  :label="t(option.labelKey)"
                  :value="option.value"
                />
              </el-select>
            </el-form-item>
          </el-form>
          <div class="test-result" v-if="testResult">
            <span :class="testResult.ok ? 'test-ok' : 'test-fail'">{{ testResult.message }}</span>
          </div>
          <template #footer>
            <div style="display: flex; justify-content: space-between; width: 100%">
              <el-button :loading="testLoading" @click="testCustomModel">{{
                t("settings.testConnection")
              }}</el-button>
              <div style="display: flex; gap: 8px">
                <el-button @click="showAddModel = false">{{ t("settings.cancel") }}</el-button>
                <el-button type="primary" @click="addCustomModel">{{
                  t("settings.add")
                }}</el-button>
              </div>
            </div>
          </template>
        </el-dialog>

        <!-- Edit Custom Model dialog -->
        <el-dialog
          v-model="showEditModel"
          :title="t('settings.editCustomModel')"
          width="460px"
          :close-on-click-modal="false"
        >
          <el-form label-position="top" @submit.prevent>
            <el-form-item :label="t('settings.modelName')">
              <el-input v-model="editModel.name" placeholder="e.g. my-gpt-4o" />
            </el-form-item>
            <el-form-item :label="t('settings.baseUrl')">
              <el-input v-model="editModel.baseUrl" placeholder="https://api.example.com/v1" />
            </el-form-item>
            <el-form-item :label="t('settings.apiKey')">
              <el-input
                v-model="editModel.apiKey"
                type="password"
                show-password
                placeholder="sk-..."
              />
            </el-form-item>
            <el-form-item :label="t('settings.apiFormat')">
              <el-select v-model="editModel.apiFormat" style="width: 100%">
                <el-option :label="t('settings.apiFormatOpenAIChat')" value="openai-chat" />
                <el-option
                  :label="t('settings.apiFormatOpenAIResponses')"
                  value="openai-responses"
                />
                <el-option :label="t('settings.apiFormatAnthropic')" value="anthropic" />
              </el-select>
            </el-form-item>
            <el-form-item :label="t('settings.reasoningEffort')">
              <el-select v-model="editModel.reasoningEffort" style="width: 100%">
                <el-option
                  v-for="option in reasoningEffortOptions"
                  :key="option.value"
                  :label="t(option.labelKey)"
                  :value="option.value"
                />
              </el-select>
            </el-form-item>
          </el-form>
          <div class="test-result" v-if="editTestResult">
            <span :class="editTestResult.ok ? 'test-ok' : 'test-fail'">{{
              editTestResult.message
            }}</span>
          </div>
          <template #footer>
            <div style="display: flex; justify-content: space-between; width: 100%">
              <el-button :loading="editTestLoading" @click="testEditModel">{{
                t("settings.testConnection")
              }}</el-button>
              <div style="display: flex; gap: 8px">
                <el-button @click="showEditModel = false">{{ t("settings.cancel") }}</el-button>
                <el-button type="primary" @click="saveEditModel">{{
                  t("settings.save")
                }}</el-button>
              </div>
            </div>
          </template>
        </el-dialog>

        <!-- Web Search (Brave) -->
        <div class="sub-label" style="margin-top: 40px">{{ t("settings.webSearch") }}</div>
        <div class="card-group">
          <div class="card-row no-border port-row">
            <div class="port-info">
              <div class="port-title">{{ t("settings.braveSearchApiKey") }}</div>
            </div>
            <div style="display: flex; gap: 8px; align-items: center; flex-shrink: 0">
              <el-input
                v-model="braveApiKey"
                type="password"
                show-password
                size="small"
                placeholder="BSA..."
                style="width: 240px"
              />
              <el-button
                size="small"
                type="primary"
                @click="saveBraveApiKey"
                :loading="braveApiKeySaving"
                >{{ t("settings.save") }}</el-button
              >
            </div>
          </div>
        </div>
        <div class="section-footer">
          <template v-for="(part, i) in t('settings.braveDesc').split('{link}')" :key="i">
            <span v-if="i > 0"
              ><a
                href="#"
                @click.prevent="openExternal('https://brave.com/search/api/')"
                style="color: var(--accent)"
                >brave.com/search/api</a
              ></span
            >{{ part }}
          </template>
        </div>
      </div>

      <!-- Skills -->
      <div v-if="activeSection === 'skills'" class="section">
        <div class="section-label">{{ t("settings.skillManagement") }}</div>

        <!-- ══ Built-in Skills ══ -->
        <div
          style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
          "
        >
          <span class="sub-label" style="margin: 0"
            >{{ t("settings.builtinSkills") }} ({{ builtinSkills.length }})</span
          >
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="skill-count-label"
              >{{ enabledCount }}/{{ builtinSkills.length }} {{ t("settings.enabledCount") }}</span
            >
          </div>
        </div>

        <div v-if="builtinSkills.length" class="card-group">
          <div
            v-for="(skill, idx) in builtinSkills"
            :key="skill.id"
            class="card-row"
            :class="{ 'no-border': idx === builtinSkills.length - 1 }"
          >
            <div class="skill-info">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                <span class="row-label">{{ skill.name }}</span>
                <el-tooltip v-if="!skill.eligible" :content="missingTooltip(skill)" placement="top">
                  <span class="badge badge-warn">{{ t("settings.skillUnavailable") }}</span>
                </el-tooltip>
              </div>
              <span class="skill-desc">{{ skill.description }}</span>
            </div>
            <el-button
              v-if="!skill.eligible"
              class="ask-agent-btn"
              size="small"
              @click="askAgentAboutSkill(skill)"
            >
              {{ t("settings.askAgent") }}
            </el-button>
            <el-switch
              v-else
              :model-value="skill.enabled && skill.eligible"
              @change="(val: boolean) => toggleBuiltinSkill(skill, val)"
            />
          </div>
        </div>

        <div v-else class="card-group">
          <div class="card-row no-border placeholder-row">
            <span class="placeholder-text">{{ t("settings.noBuiltinSkills") }}</span>
          </div>
        </div>

        <!-- ══ Custom Skills ══ -->
        <div class="sub-label">{{ t("settings.customSkills") }} ({{ customSkills.length }})</div>
        <div class="card-group">
          <template v-if="customSkills.length">
            <div
              v-for="(skill, idx) in customSkills"
              :key="skill.id"
              class="card-row"
              :class="{ 'no-border': idx === customSkills.length - 1 }"
            >
              <div class="skill-info">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                  <span class="row-label">{{ skill.name }}</span>
                  <el-tooltip
                    v-if="!skill.eligible"
                    :content="missingTooltip(skill)"
                    placement="top"
                  >
                    <span class="badge badge-warn">{{ t("settings.skillUnavailable") }}</span>
                  </el-tooltip>
                </div>
                <span class="skill-desc">{{ skill.description }}</span>
              </div>
              <el-button
                v-if="!skill.eligible"
                class="ask-agent-btn"
                size="small"
                @click="askAgentAboutSkill(skill)"
              >
                {{ t("settings.askAgent") }}
              </el-button>
              <el-switch
                v-else
                :model-value="skill.enabled && skill.eligible"
                @change="(val: boolean) => toggleCustomSkill(skill.id, val)"
              />
            </div>
          </template>
          <div v-else class="card-row no-border placeholder-row">
            <span class="placeholder-text">{{ t("settings.noCustomSkills") }}</span>
          </div>
        </div>
      </div>

      <!-- Gateway -->
      <div v-if="activeSection === 'gateway'" class="section">
        <div class="section-label">{{ t("settings.connectionStatus") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.status") }}</span>
            <div style="display: flex; align-items: center; gap: 8px">
              <span
                class="badge"
                :class="gateway.status === 'running' ? 'badge-green' : 'badge-red'"
              >
                {{ gateway.status === "running" ? t("settings.connected") : gateway.status }}
              </span>
              <el-button size="small" @click="restartGateway">{{
                t("settings.restart")
              }}</el-button>
            </div>
          </div>
        </div>

        <div class="sub-label">{{ t("settings.port") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.port") }}</span>
            <div class="port-input-group">
              <span class="port-prefix">ws://127.0.0.1 :</span>
              <el-input
                v-model="gatewayPort"
                size="small"
                style="width: 80px"
                @change="saveGatewayPort"
              />
            </div>
          </div>
        </div>
        <div class="section-footer">{{ t("settings.portDesc") }}</div>

        <div class="sub-label-row">
          <span class="sub-label" style="margin: 0">{{ t("settings.gatewayLog") }}</span>
          <el-button size="small" @click="gateway.logs = []">{{ t("settings.clear") }}</el-button>
        </div>
        <div class="gateway-log-box">
          <div v-if="gateway.logs.length === 0" class="gateway-log-empty">
            {{ t("settings.noLogs") }}
          </div>
          <div v-else class="gateway-log-content" ref="logBoxRef">
            <div v-for="(line, i) in gateway.logs" :key="i" class="gateway-log-line">
              {{ line }}
            </div>
          </div>
        </div>
      </div>

      <!-- Channels -->
      <ChannelsView v-if="activeSection === 'channels'" embedded />

      <!-- Security / Sandbox -->
      <div v-if="activeSection === 'security'" class="section">
        <div class="section-label">{{ t("settings.security") }}</div>
        <div class="card-group">
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

        <div :class="{ 'sandbox-disabled': !sandboxStatus.enabled }">
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
                  <button class="dir-add-btn" @click="addSandboxDir('rw')">
                    + {{ t("settings.sandboxAddDir") }}
                  </button>
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
                  <button class="dir-add-btn" @click="addSandboxDir('ro')">
                    + {{ t("settings.sandboxAddDir") }}
                  </button>
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
                        style="margin-left: auto; font-size: 11px"
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
                        style="margin-left: auto; font-size: 11px"
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
              <li>{{ t("settings.privacyBasicDesc3") }}</li>
            </ul>
          </div>
          <div
            class="privacy-card"
            :class="{ active: settings.privacyLevel === 'balanced' }"
            @click="setPrivacyLevel('balanced')"
          >
            <div class="privacy-card-header">
              <span class="privacy-card-icon">⚖️</span>
              <span class="privacy-card-title">{{ t("settings.privacyBalanced") }}</span>
              <span class="privacy-badge-recommended">{{ t("settings.privacyRecommended") }}</span>
            </div>
            <ul class="privacy-card-list">
              <li>{{ t("settings.privacyBalancedDesc1") }}</li>
              <li>{{ t("settings.privacyBalancedDesc2") }}</li>
              <li>{{ t("settings.privacyBalancedDesc3") }}</li>
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
              <li>{{ t("settings.privacyStrictDesc3") }}</li>
            </ul>
          </div>
        </div>
        <div class="section-footer">{{ t("settings.privacyProtectionDesc") }}</div>

        <!-- PII Detection -->
        <div class="sub-label" style="margin-top: 36px">{{ t("settings.piiDetection") }}</div>
        <div class="card-group">
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiPhone") }}</span>
            <el-switch v-model="piiToggles.phone" :disabled="settings.privacyLevel === 'basic'" />
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiIdCard") }}</span>
            <el-switch v-model="piiToggles.idCard" :disabled="settings.privacyLevel === 'basic'" />
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiBankCard") }}</span>
            <el-switch
              v-model="piiToggles.bankCard"
              :disabled="settings.privacyLevel === 'basic'"
            />
          </div>
          <div class="card-row">
            <span class="row-label">{{ t("settings.piiEmail") }}</span>
            <el-switch v-model="piiToggles.email" :disabled="settings.privacyLevel === 'basic'" />
          </div>
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.piiApiKey") }}</span>
            <el-switch v-model="piiToggles.apiKey" :disabled="settings.privacyLevel === 'basic'" />
          </div>
        </div>
        <div class="section-footer">{{ t("settings.piiDetectionDesc") }}</div>

        <!-- Sensitive File Guard -->
        <div class="sub-label" style="margin-top: 32px">{{ t("settings.sensitiveFiles") }}</div>
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

        <!-- File Access Audit -->
        <div class="sub-label" style="margin-top: 32px">{{ t("settings.fileAccessAudit") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.fileAccessAudit") }}</span>
            <el-switch
              v-model="settings.fileAccessAudit"
              :disabled="settings.privacyLevel === 'basic'"
            />
          </div>
        </div>
        <div class="section-footer">{{ t("settings.fileAccessAuditDesc") }}</div>

        <!-- Chat History (existing) -->
        <div class="sub-label" style="margin-top: 32px">{{ t("settings.chatHistory") }}</div>
        <div class="card-group">
          <div class="card-row no-border">
            <span class="row-label">{{ t("settings.chatHistory") }}</span>
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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch, computed, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { useAgentStore } from "@/stores/agents";
import { ElMessage, ElMessageBox } from "element-plus";
import ChannelsView from "@/views/ChannelsView.vue";
import microclawLogo from "../../../assets/microclaw.png";
import { t, setLocale } from "@/i18n";
import type { Locale } from "@/i18n";

const route = useRoute();
const router = useRouter();
const gateway = useGatewayStore();
const chatStore = useChatStore();
const agentStore = useAgentStore();

const logBoxRef = ref<HTMLElement | null>(null);

watch(
  () => gateway.logs.length,
  () => {
    nextTick(() => {
      if (logBoxRef.value) {
        logBoxRef.value.scrollTop = logBoxRef.value.scrollHeight;
      }
    });
  },
);

const activeSection = ref("general");
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
  return updateResult.value.message;
});

const VALID_SECTIONS = [
  "general",
  "usage",
  "models",
  "skills",
  "gateway",
  "channels",
  "security",
  "privacy",
  "about",
];

function normalizeSection(section: unknown) {
  if (section === "theme") return "general";
  if (section === "workspace") return "gateway";
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
const sandboxSystemDirs = reactive<{ rw: string[]; ro: string[] }>({ rw: [], ro: [] });
const sandboxCapabilities = ref<string[]>([]);
const capsRestarting = ref(false);
const sandboxRestarting = ref(false);

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

async function addSandboxDir(access: "rw" | "ro") {
  const result = await window.openclaw.sandbox.addUserDir({ access });
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
  startMinimized: false,
  themeMode: "light",
  privacyLevel: "balanced" as "basic" | "balanced" | "strict",
  fileAccessAudit: true,
});

const piiToggles = reactive({
  phone: true,
  idCard: true,
  bankCard: true,
  email: true,
  apiKey: true,
});

// --- Models & API state ---
type ApiFormat = "openai-chat" | "openai-responses" | "anthropic";
type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

interface ModelEntry {
  providerKey: string;
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: ApiFormat;
  reasoningEffort?: ReasoningEffort;
}

interface ModelFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  reasoningEffort: ReasoningEffort;
}

const reasoningEffortOptions: Array<{ value: ReasoningEffort; labelKey: string }> = [
  { value: "off", labelKey: "settings.reasoningOff" },
  { value: "minimal", labelKey: "settings.reasoningMinimal" },
  { value: "low", labelKey: "settings.reasoningLow" },
  { value: "medium", labelKey: "settings.reasoningMedium" },
  { value: "high", labelKey: "settings.reasoningHigh" },
  { value: "xhigh", labelKey: "settings.reasoningXHigh" },
  { value: "adaptive", labelKey: "settings.reasoningAdaptive" },
];

function buildProviderKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
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

function resolveApiValue(apiFormat: ApiFormat): string {
  if (apiFormat === "anthropic") return "anthropic-messages";
  if (apiFormat === "openai-responses") return "openai-responses";
  return "openai-completions";
}

function formatApiLabel(apiFormat?: ApiFormat): string {
  if (apiFormat === "anthropic") return t("settings.apiFormatAnthropic");
  if (apiFormat === "openai-responses") return t("settings.apiFormatOpenAIResponses");
  return t("settings.apiFormatOpenAIChat");
}

function formatReasoningEffort(value?: ReasoningEffort): string {
  const key = reasoningEffortOptions.find((option) => option.value === value)?.labelKey;
  return key ? t(key) : t("settings.reasoningOff");
}

function getModelRef(model: Pick<ModelEntry, "providerKey" | "id">): string {
  return `${model.providerKey}/${model.id}`;
}

function describeCustomModel(model: ModelEntry): string {
  const parts = [] as string[];
  if (model.baseUrl) parts.push(model.baseUrl);
  parts.push(formatApiLabel(model.apiFormat));
  const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
  parts.push(
    reasoningEffort === "off"
      ? t("settings.reasoningOffDesc")
      : t("settings.reasoningDesc", { level: formatReasoningEffort(reasoningEffort) }),
  );
  return parts.join(" · ");
}

function resetModelForm(form: ModelFormState): void {
  form.name = "";
  form.baseUrl = "";
  form.apiKey = "";
  form.apiFormat = "openai-chat";
  form.reasoningEffort = "off";
}

function ensureReasoningPreset(form: ModelFormState): void {
  if (form.apiFormat === "openai-responses" && form.reasoningEffort === "off") {
    form.reasoningEffort = "low";
  }
}

const _builtinModels = ref<ModelEntry[]>([
  { providerKey: "", id: "MAI-01-Preview", name: "MAI-01-Preview" },
]);
const customModels = ref<ModelEntry[]>([]);
const selectedModel = ref("Pony-Alpha-2");
const gatewayPort = ref("18789");
const showAddModel = ref(false);
const newModel = reactive<ModelFormState>({
  name: "",
  baseUrl: "",
  apiKey: "",
  apiFormat: "openai-chat",
  reasoningEffort: "off",
});
const testLoading = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

const showEditModel = ref(false);
const editingIndex = ref(-1);
const editModel = reactive<ModelFormState>({
  name: "",
  baseUrl: "",
  apiKey: "",
  apiFormat: "openai-chat",
  reasoningEffort: "off",
});
const editTestLoading = ref(false);
const editTestResult = ref<{ ok: boolean; message: string } | null>(null);

const builtinSkills = ref<SkillEntry[]>([]);
const customSkills = ref<SkillEntry[]>([]);
const skillsRefreshing = ref(false);

const enabledCount = computed(
  () => builtinSkills.value.filter((s) => s.enabled && s.eligible).length,
);

function missingTooltip(skill: SkillEntry): string {
  const reasons: string[] = [];
  if (skill.missingBins?.length) {
    reasons.push(t("settings.skillMissingBins", { bins: skill.missingBins.join(", ") }));
  }
  if (skill.missingAnyBins?.length) {
    reasons.push(t("settings.skillMissingAnyBins", { bins: skill.missingAnyBins.join(", ") }));
  }
  if (skill.missingEnv?.length) {
    reasons.push(t("settings.skillMissingEnv", { env: skill.missingEnv.join(", ") }));
  }
  if (skill.missingConfig?.length) {
    reasons.push(t("settings.skillMissingConfig", { config: skill.missingConfig.join(", ") }));
  }
  if (skill.osMismatch) {
    reasons.push(t("settings.skillOsMismatch", { os: (skill.osRequired ?? []).join(", ") }));
  }
  if (reasons.length === 0) return t("settings.skillUnavailable");
  return `${t("settings.skillUnavailablePrefix")} ${reasons.join("; ")}`;
}

// Start a fresh MicroClaw (main agent) chat pre-filled with a prompt asking the
// agent how to make an unavailable skill work. The prompt carries just the skill
// name and the same "unavailable" reason shown in the hover tooltip.
async function askAgentAboutSkill(skill: SkillEntry) {
  const prompt = t("settings.askAgentPrompt", {
    name: skill.name,
    reason: missingTooltip(skill),
  });
  agentStore.selectAgent("main");
  chatStore.newSession("main");
  await router.push("/chat/main");
  chatStore.pendingPrompt = prompt;
}

async function loadSkills(refresh = false): Promise<void> {
  const skills = refresh
    ? await window.openclaw.skills.refresh()
    : await window.openclaw.skills.list();
  // Built-in and managed workspace skills are presented together as a single
  // "Built-in Skills" list (we are Windows-only, so no platform grouping). Each
  // entry keeps its `source` so toggles route to the correct backend handler.
  builtinSkills.value = [...skills.builtin, ...(skills.managed ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  customSkills.value = skills.custom;
}

async function autoRefreshSkills(): Promise<void> {
  if (skillsRefreshing.value) return;
  skillsRefreshing.value = true;
  try {
    await loadSkills(true);
  } catch {
    // Skills refresh not available; keep the last loaded list.
  } finally {
    skillsRefreshing.value = false;
  }
}

async function toggleBuiltinSkill(skill: SkillEntry, enabled: boolean) {
  // Managed workspace skills persist via skills.entries; bundled skills via the
  // allowBundled allowlist. Route to the correct handler based on the skill source.
  if (skill.source === "managed") {
    await toggleManagedSkill(skill.id, enabled);
  } else {
    await toggleSkill(skill.id, enabled);
  }
}

async function toggleSkill(skillId: string, enabled: boolean) {
  const skill = builtinSkills.value.find((s) => s.id === skillId);
  if (skill) skill.enabled = enabled;

  // allowBundled must only list bundled built-in skills, never managed ones.
  const allowBundled = builtinSkills.value
    .filter((s) => s.source === "builtin" && s.enabled)
    .map((s) => s.id);

  try {
    await window.openclaw.skills.updateAllowlist(allowBundled);
    ElMessage.success(t("settings.skillConfigUpdated"));
  } catch (err: any) {
    if (skill) skill.enabled = !enabled;
    ElMessage.error(t("settings.skillConfigFailed", { error: err.message || err }));
  }
}

async function toggleManagedSkill(skillId: string, enabled: boolean) {
  const skill = builtinSkills.value.find((s) => s.id === skillId);
  if (skill) skill.enabled = enabled;

  try {
    await window.openclaw.skills.updateManagedEntries({ [skillId]: { enabled } });
    ElMessage.success(t("settings.managedSkillConfigUpdated"));
  } catch (err: any) {
    if (skill) skill.enabled = !enabled;
    ElMessage.error(t("settings.managedSkillConfigFailed", { error: err.message || err }));
  }
}

async function toggleCustomSkill(skillId: string, enabled: boolean) {
  const skill = customSkills.value.find((s) => s.id === skillId);
  if (skill) skill.enabled = enabled;

  // Custom skills persist their on/off state via the same per-skill entries map.
  try {
    await window.openclaw.skills.updateManagedEntries({ [skillId]: { enabled } });
    ElMessage.success(t("settings.skillConfigUpdated"));
  } catch (err: any) {
    if (skill) skill.enabled = !enabled;
    ElMessage.error(t("settings.skillConfigFailed", { error: err.message || err }));
  }
}

// --- Brave Search API ---
const braveApiKey = ref("");
const braveApiKeySaving = ref(false);

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
}
const usageData = ref<UsageStats | null>(null);
const usageLoading = ref(false);
const usageError = ref("");

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
  skills: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2.5a2 2 0 0 1 2.83 2.83l-9.9 9.9-3.54.71.71-3.54 9.9-9.9z"/></svg>`,
  gateway: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="6" rx="1.5"/><rect x="3" y="11" width="14" height="6" rx="1.5"/><circle cx="6" cy="6" r=".75" fill="currentColor" stroke="none"/><circle cx="6" cy="14" r=".75" fill="currentColor" stroke="none"/><path d="M9 6h5M9 14h5"/></svg>`,
  channels: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/><path d="M6.8 6.8a4.5 4.5 0 0 0 0 6.4M13.2 6.8a4.5 4.5 0 0 1 0 6.4M4.4 4.4a8 8 0 0 0 0 11.2M15.6 4.4a8 8 0 0 1 0 11.2"/></svg>`,
  security: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l6 3v5c0 4-2.5 6.5-6 8-3.5-1.5-6-4-6-8V5l6-3z"/><path d="M7.5 10l2 2 3.5-4"/></svg>`,
  privacy: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="9" rx="2"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/><circle cx="10" cy="14" r="1" fill="currentColor" stroke="none"/></svg>`,
  about: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 9v5"/><circle cx="10" cy="6.5" r="0.75" fill="currentColor" stroke="none"/></svg>`,
};

const menuItems = computed(() => [
  { id: "general", label: t("settings.menu.general"), color: "#636366", svg: svg.general },
  { id: "usage", label: t("settings.menu.usage"), color: "#636366", svg: svg.usage },
  { id: "models", label: t("settings.menu.models"), color: "#636366", svg: svg.models },
  { id: "skills", label: t("settings.menu.skills"), color: "#636366", svg: svg.skills },
  { id: "gateway", label: t("settings.menu.gateway"), color: "#636366", svg: svg.gateway },
  { id: "channels", label: t("settings.menu.channels"), color: "#636366", svg: svg.channels },
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
watch(
  () => settings.autoStart,
  (v) => window.openclaw.settings.set("autoStart", v),
);
watch(
  () => settings.startMinimized,
  (v) => window.openclaw.settings.set("startMinimized", v),
);
watch(
  () => settings.themeMode,
  (v) => {
    window.openclaw.settings.set("themeMode", v);
    applyTheme(v);
  },
);

function setPrivacyLevel(level: "basic" | "balanced" | "strict") {
  settings.privacyLevel = level;
  window.openclaw.settings.set("privacyLevel", level);
  // Auto-configure PII toggles based on level
  if (level === "basic") {
    piiToggles.phone = false;
    piiToggles.idCard = false;
    piiToggles.bankCard = false;
    piiToggles.email = false;
    piiToggles.apiKey = false;
    settings.fileAccessAudit = false;
  } else if (level === "balanced") {
    piiToggles.phone = true;
    piiToggles.idCard = true;
    piiToggles.bankCard = true;
    piiToggles.email = true;
    piiToggles.apiKey = true;
    settings.fileAccessAudit = true;
  } else {
    piiToggles.phone = true;
    piiToggles.idCard = true;
    piiToggles.bankCard = true;
    piiToggles.email = true;
    piiToggles.apiKey = true;
    settings.fileAccessAudit = true;
  }
}
watch(
  () => newModel.apiFormat,
  () => ensureReasoningPreset(newModel),
);
watch(
  () => editModel.apiFormat,
  () => ensureReasoningPreset(editModel),
);

// --- Auto-load data when tab is selected ---
watch(activeSection, (v) => {
  if (v === "usage" && !usageData.value && !usageLoading.value) {
    loadUsage();
  }
  if (v === "security") {
    loadSandboxStatus();
  }
  if (v === "skills") {
    autoRefreshSkills();
  }
});

onMounted(async () => {
  // Load persisted app settings
  const saved = await window.openclaw.settings.get();
  if (saved) {
    settings.language = saved.language ?? "en-US";
    settings.autoStart = saved.autoStart ?? false;
    settings.startMinimized = saved.startMinimized ?? false;
    settings.themeMode = saved.themeMode ?? "light";
    settings.privacyLevel = (saved.privacyLevel ?? "balanced") as "basic" | "balanced" | "strict";
    // Init PII toggles based on loaded privacy level
    if (settings.privacyLevel === "basic") {
      piiToggles.phone = false;
      piiToggles.idCard = false;
      piiToggles.bankCard = false;
      piiToggles.email = false;
      piiToggles.apiKey = false;
      settings.fileAccessAudit = false;
    }
  }

  // Load existing config for models & gateway
  const config = await window.openclaw.config.read();
  if (config) {
    // Gateway port
    gatewayPort.value = String(config.gateway?.port ?? (gateway.port || 18789));

    // Custom models from config
    const providers = config.models?.providers ?? {};
    const modelDefaults = config.agents?.defaults?.models ?? {};
    const loaded: ModelEntry[] = [];
    for (const [key, val] of Object.entries(providers) as [string, any][]) {
      const models = val.models ?? [];
      for (const m of models) {
        const modelId = m.id ?? key;
        const modelRef = `${key}/${modelId}`;
        const apiFormat = normalizeApiFormat(val.api);
        const reasoningFallback =
          m.reasoning === true || apiFormat === "openai-responses" ? "low" : "off";
        loaded.push({
          providerKey: key,
          id: modelId,
          name: m.name ?? modelId ?? key,
          baseUrl: val.baseUrl ?? "",
          apiKey: val.apiKey ?? "",
          apiFormat,
          reasoningEffort: normalizeReasoningEffort(
            modelDefaults[modelRef]?.params?.thinking,
            reasoningFallback,
          ),
        });
      }
    }
    customModels.value = loaded;

    const defaultModelConfig = config.agents?.defaults?.model;
    const primary =
      typeof defaultModelConfig === "string" ? defaultModelConfig : defaultModelConfig?.primary;
    if (primary) {
      const matched = loaded.find((model) => getModelRef(model) === primary);
      selectedModel.value =
        matched?.id ?? (primary.includes("/") ? primary.split("/").pop()! : primary);
    } else if (loaded.length > 0) {
      selectedModel.value = loaded[0].id;
    }
  }

  // Load Brave Search API key from config
  if (config?.tools?.web?.search?.apiKey) {
    braveApiKey.value = config.tools.web.search.apiKey;
  }

  // Load skills from disk
  try {
    await loadSkills(false);
  } catch {
    // Skills listing not available
  }
});

// --- Model & Gateway actions ---

async function persistModelsConfig() {
  // Validate custom models before saving
  const seenModelRefs = new Set<string>();
  for (const m of customModels.value) {
    if (!m.id || !m.id.trim()) {
      throw new Error("Model ID cannot be empty");
    }
    if (m.baseUrl !== undefined && m.baseUrl !== "" && !/^https?:\/\/.+/.test(m.baseUrl)) {
      throw new Error(`Invalid Base URL for model "${m.name}"`);
    }
    const modelRef = getModelRef(m);
    if (seenModelRefs.has(modelRef)) {
      throw new Error(`Duplicate model entry "${modelRef}"`);
    }
    seenModelRefs.add(modelRef);
  }

  const config = (await window.openclaw.config.read()) || {};
  const providerConfig: Record<string, any> = {};
  const existingProviderKeys = new Set(Object.keys(config.models?.providers ?? {}));
  const existingModelDefaults = config.agents?.defaults?.models ?? {};

  for (const m of customModels.value) {
    const providerKey = buildProviderKey(m.providerKey || m.id);
    const reasoningEffort = normalizeReasoningEffort(m.reasoningEffort);
    const reasoningEnabled = m.apiFormat === "openai-responses" || reasoningEffort !== "off";
    providerConfig[providerKey] = {
      ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
      apiKey: m.apiKey || "",
      api: resolveApiValue(m.apiFormat || "openai-chat"),
      models: [
        {
          id: m.id,
          name: m.name,
          ...(reasoningEnabled ? { reasoning: true } : {}),
          ...(m.apiFormat !== "anthropic" ? { input: ["text", "image"] } : {}),
        },
      ],
    };
  }

  const managedProviderKeys = new Set<string>([
    ...existingProviderKeys,
    ...Object.keys(providerConfig),
  ]);
  const nextModelDefaults: Record<string, any> = {};

  for (const [modelRef, modelConfig] of Object.entries(existingModelDefaults) as [string, any][]) {
    const providerKey = modelRef.split("/")[0];
    if (!managedProviderKeys.has(providerKey)) {
      nextModelDefaults[modelRef] = modelConfig;
    }
  }

  for (const m of customModels.value) {
    const modelRef = getModelRef(m);
    const reasoningEffort = normalizeReasoningEffort(m.reasoningEffort);
    if (m.apiFormat !== "openai-responses" && reasoningEffort === "off") continue;
    const existingModelConfig =
      typeof existingModelDefaults[modelRef] === "object" && existingModelDefaults[modelRef]
        ? existingModelDefaults[modelRef]
        : {};
    nextModelDefaults[modelRef] = {
      ...existingModelConfig,
      params: {
        ...(existingModelConfig.params ?? {}),
        thinking: reasoningEffort,
      },
    };
  }

  config.models = {
    ...(config.models ?? {}),
    mode: config.models?.mode ?? "merge",
    providers: providerConfig,
  };
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};

  if (Object.keys(nextModelDefaults).length > 0) {
    config.agents.defaults.models = nextModelDefaults;
  } else {
    delete config.agents.defaults.models;
  }

  const selectedEntry =
    customModels.value.find((model) => model.id === selectedModel.value) ?? customModels.value[0];
  if (selectedEntry) {
    const existingDefaultModel =
      typeof config.agents.defaults.model === "object" && config.agents.defaults.model
        ? config.agents.defaults.model
        : {};
    selectedModel.value = selectedEntry.id;
    config.agents.defaults.model = {
      ...existingDefaultModel,
      primary: getModelRef(selectedEntry),
    };
  } else {
    delete config.agents.defaults.model;
  }

  await window.openclaw.config.write(config);
}

async function persistAndRestart(successMsg: string) {
  try {
    await persistModelsConfig();
  } catch (err: any) {
    ElMessage.error(t("settings.configSaveFailed", { error: err.message || err }));
    return;
  }
  ElMessage.success(successMsg);
}

async function selectModel(id: string) {
  selectedModel.value = id;
  await persistAndRestart(t("settings.modelSwitched", { model: id }));
}

async function addCustomModel() {
  const name = newModel.name.trim();
  if (!name) {
    ElMessage.warning(t("settings.modelNameRequired"));
    return;
  }
  const baseUrl = newModel.baseUrl.trim();
  if (!baseUrl) {
    ElMessage.warning(t("settings.baseUrlRequired"));
    return;
  }
  if (customModels.value.some((model) => model.id === name)) {
    ElMessage.warning(t("settings.modelNameExists"));
    return;
  }
  customModels.value.push({
    providerKey: buildProviderKey(name),
    id: name,
    name,
    baseUrl,
    apiKey: newModel.apiKey.trim(),
    apiFormat: newModel.apiFormat,
    reasoningEffort: normalizeReasoningEffort(newModel.reasoningEffort),
  });
  showAddModel.value = false;
  resetModelForm(newModel);
  testResult.value = null;
  selectedModel.value = name;
  await persistAndRestart(t("settings.customModelAdded"));
}

function editCustomModel(idx: number) {
  const m = customModels.value[idx];
  editingIndex.value = idx;
  editModel.name = m.name;
  editModel.baseUrl = m.baseUrl || "";
  editModel.apiKey = m.apiKey || "";
  editModel.apiFormat = m.apiFormat || "openai-chat";
  editModel.reasoningEffort = normalizeReasoningEffort(m.reasoningEffort);
  editTestResult.value = null;
  showEditModel.value = true;
}

async function saveEditModel() {
  const name = editModel.name.trim();
  if (!name) {
    ElMessage.warning(t("settings.modelNameRequired"));
    return;
  }
  const baseUrl = editModel.baseUrl.trim();
  if (!baseUrl) {
    ElMessage.warning(t("settings.baseUrlRequired"));
    return;
  }
  const idx = editingIndex.value;
  if (idx < 0 || idx >= customModels.value.length) return;
  if (customModels.value.some((model, modelIndex) => model.id === name && modelIndex !== idx)) {
    ElMessage.warning(t("settings.modelNameExists"));
    return;
  }
  customModels.value[idx] = {
    providerKey: customModels.value[idx].providerKey,
    id: name,
    name,
    baseUrl,
    apiKey: editModel.apiKey.trim(),
    apiFormat: editModel.apiFormat,
    reasoningEffort: normalizeReasoningEffort(editModel.reasoningEffort),
  };
  showEditModel.value = false;
  selectedModel.value = name;
  await persistAndRestart(t("settings.customModelUpdated"));
}

async function testEditModel() {
  const baseUrl = editModel.baseUrl.trim();
  const apiKey = editModel.apiKey.trim();
  if (!baseUrl) {
    ElMessage.warning(t("settings.baseUrlRequired"));
    return;
  }
  editTestLoading.value = true;
  editTestResult.value = null;
  try {
    const result = await window.openclaw.model.testConnection({
      baseUrl,
      apiKey,
      apiFormat: editModel.apiFormat,
      modelName: editModel.name.trim(),
      reasoningEffort: normalizeReasoningEffort(editModel.reasoningEffort),
    });
    editTestResult.value = result;
  } catch (err: any) {
    editTestResult.value = {
      ok: false,
      message: t("settings.connectionFailed", { error: err.message || "Network error" }),
    };
  } finally {
    editTestLoading.value = false;
  }
}

async function removeCustomModel(idx: number) {
  const removed = customModels.value[idx];
  customModels.value.splice(idx, 1);
  if (removed.id === selectedModel.value && customModels.value.length) {
    selectedModel.value = customModels.value[0].id;
  }
  await persistAndRestart(t("settings.customModelDeleted"));
}

async function testCustomModel() {
  const baseUrl = newModel.baseUrl.trim();
  const apiKey = newModel.apiKey.trim();
  if (!baseUrl) {
    ElMessage.warning(t("settings.baseUrlRequired"));
    return;
  }
  testLoading.value = true;
  testResult.value = null;
  try {
    const result = await window.openclaw.model.testConnection({
      baseUrl,
      apiKey,
      apiFormat: newModel.apiFormat,
      modelName: newModel.name.trim(),
      reasoningEffort: normalizeReasoningEffort(newModel.reasoningEffort),
    });
    testResult.value = result;
  } catch (err: any) {
    testResult.value = {
      ok: false,
      message: t("settings.connectionFailed", { error: err.message || "Network error" }),
    };
  } finally {
    testLoading.value = false;
  }
}

async function saveBraveApiKey() {
  const key = braveApiKey.value.trim();
  braveApiKeySaving.value = true;
  try {
    const config = (await window.openclaw.config.read()) || {};
    config.tools = config.tools || {};
    config.tools.web = config.tools.web || {};
    if (key) {
      config.tools.web.search = {
        ...config.tools.web.search,
        provider: "brave",
        apiKey: key,
      };
    } else {
      delete config.tools.web.search;
    }
    await window.openclaw.config.write(config);
    ElMessage.success(key ? t("settings.braveApiKeySaved") : t("settings.braveApiKeyCleared"));
  } catch (err: any) {
    ElMessage.error(t("settings.saveFailed", { error: err.message || err }));
  } finally {
    braveApiKeySaving.value = false;
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

async function saveGatewayPort() {
  const port = parseInt(gatewayPort.value, 10);
  if (!port || port < 1 || port > 65535) {
    ElMessage.warning(t("settings.invalidPort"));
    return;
  }
  try {
    const config = (await window.openclaw.config.read()) || {};
    config.gateway = config.gateway || {};
    config.gateway.port = port;
    await window.openclaw.config.write(config);
    await window.openclaw.gateway.restart();
    ElMessage.success(t("settings.portUpdated"));
  } catch (err: any) {
    ElMessage.error(t("settings.portUpdateFailed", { error: err.message }));
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

.settings-title {
  padding: 0 16px 16px;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 8px;
}

.menu-list {
  flex: 1;
  overflow-y: auto;
}

.settings-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px 7px 16px;
  cursor: pointer;
  border-radius: 8px;
  margin: 1px 8px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 400;
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

.section-label,
.section-header-title,
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

  .port-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .port-input-group {
    width: 100%;
  }

  .budget-bar-wrapper {
    width: 100%;
    align-items: flex-start;
  }

  .custom-model-actions {
    align-self: flex-end;
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

.section-actions {
  margin-top: 16px;
  padding-left: 2px;
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
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}

.section-header-title {
  padding-left: 4px;
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

.badge {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  font-weight: 500;
  padding: 3px 12px;
  border-radius: 20px;
  white-space: nowrap;
}

.badge-green {
  background: rgba(52, 199, 89, 0.12);
  color: #34c759;
  border: 1px solid rgba(52, 199, 89, 0.25);
}

.badge-red {
  background: rgba(255, 59, 48, 0.12);
  color: #ff3b30;
  border: 1px solid rgba(255, 59, 48, 0.25);
}

.custom-model-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.custom-model-info .row-sub {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-model-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.port-row {
  align-items: flex-start;
  padding: 20px;
  gap: 16px;
  min-height: 80px;
}

.port-info {
  flex: 1;
  min-width: 0;
}

.port-title {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-primary);
}

.port-input-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px 4px 12px;
}

.port-prefix {
  font-size: 13px;
  color: var(--text-muted);
  white-space: nowrap;
}

.gateway-log-box {
  margin-top: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  height: 240px;
  overflow: hidden;
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
  font-size: 12px;
}

.gateway-log-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
}

.gateway-log-content {
  height: 100%;
  overflow-y: auto;
  padding: 10px 14px;
}

.gateway-log-line {
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.6;
  color: var(--text-primary);
}

.port-input-group :deep(.el-input__wrapper) {
  box-shadow: none !important;
  background: transparent;
  padding: 0;
}

.port-input-group :deep(.el-input__inner) {
  font-size: 13px;
  text-align: center;
  font-weight: 400;
}

.settings-view :deep(.el-input__inner),
.settings-view :deep(.el-select__selected-item),
.settings-view :deep(.el-radio__label),
.settings-view :deep(.el-button) {
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
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

.skill-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.skill-desc {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge-blue {
  background: var(--accent-subtle);
  color: var(--accent);
  border: 1px solid var(--accent-light);
}

.badge-orange {
  background: rgba(255, 149, 0, 0.12);
  color: #ff9500;
  border: 1px solid rgba(255, 149, 0, 0.25);
}

.badge-gray {
  background: rgba(142, 142, 147, 0.12);
  color: #8e8e93;
  border: 1px solid rgba(142, 142, 147, 0.25);
}

.badge-warn {
  background: rgba(255, 149, 0, 0.12);
  color: #b26a00;
  border: 1px solid rgba(255, 149, 0, 0.3);
}

.switch-wrap {
  display: inline-flex;
  align-items: center;
}

.ask-agent-btn {
  flex-shrink: 0;
  --el-button-hover-text-color: var(--accent);
  --el-button-hover-border-color: var(--accent-light);
  --el-button-hover-bg-color: var(--accent-subtle);
}

.skill-count-label {
  font-size: 12px;
  color: var(--text-muted);
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
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.app-tag .tag-remove:hover {
  color: #ff3b30;
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
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 16px;
  font-weight: bold;
  padding: 0 2px;
  line-height: 1;
}
.tag-add-btn:hover {
  opacity: 0.7;
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
.dir-add-btn {
  background: none;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
  transition: background 0.15s;
}
.dir-add-btn:hover {
  background: var(--bg-tertiary);
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
  grid-template-columns: repeat(3, 1fr);
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

.privacy-badge-recommended {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(212, 168, 67, 0.15);
  color: var(--accent-selected);
  margin-left: auto;
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
