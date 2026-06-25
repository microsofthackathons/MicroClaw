import type { Meta, StoryObj } from "@storybook/vue3";
import UiInput from "./UiInput.vue";

const meta = {
  title: "UI/UiInput",
  component: UiInput,
  tags: ["autodocs"],
  args: {
    modelValue: "",
    placeholder: "Type here...",
    size: "md",
    invalid: false,
    disabled: false,
    type: "text",
    showPassword: false,
  },
  argTypes: {
    size: {
      control: "select",
      options: ["sm", "md", "lg"],
    },
  },
} satisfies Meta<typeof UiInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => ({
    components: { UiInput },
    setup() {
      return { args };
    },
    template: `
      <div style="width: 320px;">
        <UiInput
          v-bind="args"
          :model-value="args.modelValue"
          @update:modelValue="args.modelValue = $event"
        />
      </div>
    `,
  }),
};

export const WithLabelAndHint: Story = {
  render: (args) => ({
    components: { UiInput },
    setup() {
      return { args };
    },
    template: `
      <div style="width: 360px;">
        <UiInput
          v-bind="args"
          :model-value="args.modelValue"
          placeholder="sk-..."
          @update:modelValue="args.modelValue = $event"
        >
          <template #label>API Key</template>
          <template #hint>Stored locally and masked by default.</template>
        </UiInput>
      </div>
    `,
  }),
};

export const PasswordToggle: Story = {
  args: {
    modelValue: "secret-value",
    showPassword: true,
  },
  render: (args) => ({
    components: { UiInput },
    setup() {
      return { args };
    },
    template: `
      <div style="width: 320px;">
        <UiInput
          v-bind="args"
          :model-value="args.modelValue"
          @update:modelValue="args.modelValue = $event"
        />
      </div>
    `,
  }),
};
