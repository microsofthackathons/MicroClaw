import { defineStore } from "pinia";
import { ref } from "vue";

export interface Channel {
  id: string;
  name: string;
  icon: string;
  type: string;
  connected: boolean;
}

export const useChannelStore = defineStore("channels", () => {
  const channels = ref<Channel[]>([]);

  async function fetchChannels() {
    try {
      const result = await window.openclaw.channels.list();
      if (result.channels) {
        channels.value = result.channels as Channel[];
      }
    } catch {
      // Keep the list empty if the Gateway channel status request fails.
    }
  }

  return { channels, fetchChannels };
});
