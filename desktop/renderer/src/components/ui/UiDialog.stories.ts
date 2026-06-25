import type { Meta, StoryObj } from "@storybook/vue3";
import { ref } from "vue";
import UiButton from "./UiButton.vue";
import UiDialog from "./UiDialog.vue";
import UiInput from "./UiInput.vue";

const meta = {
  title: "UI/UiDialog",
  component: UiDialog,
  tags: ["autodocs"],
  args: {
    title: "Add Custom Model",
    size: "md",
    variant: "elevated",
    titleAlign: "center",
    closeOnOverlay: true,
    showClose: true,
    modelValue: true,
  },
  argTypes: {
    size: {
      control: "select",
      options: ["sm", "md", "lg"],
    },
    variant: {
      control: "select",
      options: ["default", "elevated"],
    },
    titleAlign: {
      control: "inline-radio",
      options: ["left", "center"],
    },
  },
} satisfies Meta<typeof UiDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => ({
    components: { UiDialog, UiInput, UiButton },
    setup() {
      const open = ref(args.modelValue);
      const name = ref("");
      const apiKey = ref("");
      return { args, open, name, apiKey };
    },
    template: `
      <div style="min-height: 480px; min-width: 980px; display: grid; place-items: center; background: #f2f2f5;">
        <UiButton variant="secondary" size="md" @click="open = true">Open Dialog</UiButton>
        <UiDialog v-bind="args" v-model="open">
          <div style="display: grid; gap: 14px; min-width: 460px; padding-top: 2px;">
            <UiInput v-model="name" size="lg" placeholder="e.g. my-gpt-4o">
              <template #label>Model Name</template>
            </UiInput>
            <UiInput v-model="apiKey" size="lg" show-password placeholder="sk-...">
              <template #label>API Key</template>
            </UiInput>
          </div>
          <template #footer>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; width:100%;">
              <UiButton variant="outline" size="lg" :block="true" @click="open = false">Cancel</UiButton>
              <UiButton variant="default" size="lg" :block="true">Save</UiButton>
            </div>
          </template>
        </UiDialog>
      </div>
    `,
  }),
};

export const LargeSize: Story = {
  args: {
    size: "lg",
    title: "Dialog Size: Large",
  },
  render: (args) => ({
    components: { UiDialog, UiButton },
    setup() {
      const open = ref(true);
      return { args, open };
    },
    template: `
      <div style="min-width: 900px; min-height: 340px;">
        <UiDialog v-bind="args" v-model="open">
          <p style="margin: 0; line-height: 1.6;">
            This story previews shell sizing and spacing behavior.
          </p>
          <template #footer>
            <UiButton variant="secondary" size="sm" @click="open = false">Close</UiButton>
          </template>
        </UiDialog>
      </div>
    `,
  }),
};

export const FooterHorizontalActions: Story = {
  args: {
    title: "Footer: Horizontal Actions",
    titleAlign: "center",
    size: "md",
  },
  render: (args) => ({
    components: { UiDialog, UiButton, UiInput },
    setup() {
      const open = ref(true);
      const model = ref("");
      return { args, open, model };
    },
    template: `
      <div style="min-height: 460px; min-width: 980px; display: grid; place-items: center; background: #f2f2f5;">
        <UiDialog v-bind="args" v-model="open">
          <div style="display:grid; gap:14px; min-width:460px;">
            <UiInput v-model="model" size="lg" placeholder="e.g. my-gpt-4o">
              <template #label>Model Name</template>
            </UiInput>
          </div>
          <template #footer>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; width:100%;">
              <UiButton variant="outline" size="lg" :block="true" @click="open = false">Cancel</UiButton>
              <UiButton variant="default" size="lg" :block="true">Save</UiButton>
            </div>
          </template>
        </UiDialog>
      </div>
    `,
  }),
};

export const FooterVerticalActions: Story = {
  args: {
    title: "Footer: Vertical Actions",
    titleAlign: "center",
    size: "md",
  },
  render: (args) => ({
    components: { UiDialog, UiButton, UiInput },
    setup() {
      const open = ref(true);
      const apiKey = ref("");
      return { args, open, apiKey };
    },
    template: `
      <div style="min-height: 460px; min-width: 980px; display: grid; place-items: center; background: #f2f2f5;">
        <UiDialog v-bind="args" v-model="open">
          <div style="display:grid; gap:14px; min-width:460px;">
            <UiInput v-model="apiKey" size="lg" show-password placeholder="sk-...">
              <template #label>API Key</template>
            </UiInput>
          </div>
          <template #footer>
            <div style="display:grid; grid-template-columns: 1fr; gap:10px; width:100%;">
              <UiButton variant="default" size="lg" :block="true">Save and continue</UiButton>
              <UiButton variant="outline" size="lg" :block="true" @click="open = false">Not now</UiButton>
            </div>
          </template>
        </UiDialog>
      </div>
    `,
  }),
};
