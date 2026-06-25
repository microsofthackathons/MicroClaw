import type { Meta, StoryObj } from "@storybook/vue3";
import UiButton from "./UiButton.vue";

const meta = {
  title: "UI/UiButton",
  component: UiButton,
  tags: ["autodocs"],
  args: {
    variant: "default",
    size: "md",
    loading: false,
    disabled: false,
    block: false,
    type: "button",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "secondary", "outline", "ghost", "destructive"],
    },
    size: {
      control: "select",
      options: ["sm", "md", "lg", "icon"],
    },
  },
} satisfies Meta<typeof UiButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => ({
    components: { UiButton },
    setup() {
      return { args };
    },
    template: `<UiButton v-bind="args">Button</UiButton>`,
  }),
};

export const Variants: Story = {
  render: () => ({
    components: { UiButton },
    template: `
      <div style="display:grid; grid-template-columns: repeat(3, minmax(140px, 1fr)); gap: 12px; width: 520px;">
        <UiButton variant="default">Default</UiButton>
        <UiButton variant="secondary">Secondary</UiButton>
        <UiButton variant="outline">Outline</UiButton>
        <UiButton variant="ghost">Ghost</UiButton>
        <UiButton variant="destructive">Destructive</UiButton>
        <UiButton :loading="true">Loading</UiButton>
      </div>
    `,
  }),
};

export const Sizes: Story = {
  render: () => ({
    components: { UiButton },
    template: `
      <div style="display:flex; align-items:center; gap: 10px;">
        <UiButton size="sm">Small</UiButton>
        <UiButton size="md">Medium</UiButton>
        <UiButton size="lg">Large</UiButton>
        <UiButton size="icon" aria-label="icon-only">+</UiButton>
      </div>
    `,
  }),
};
