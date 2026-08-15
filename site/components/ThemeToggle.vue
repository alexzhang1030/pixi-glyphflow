<script setup lang="ts">
import { computed } from "vue";

import { useColorMode } from "#imports";

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");

function toggleTheme(): void {
  colorMode.preference = isDark.value ? "light" : "dark";
}
</script>

<template>
  <button
    class="icon-button"
    type="button"
    :aria-label="isDark ? 'Use light theme' : 'Use dark theme'"
    :aria-pressed="isDark"
    data-testid="theme-toggle"
    @click="toggleTheme"
  >
    <ClientOnly>
      <svg
        v-if="isDark"
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      >
        <circle cx="12" cy="12" r="3.5" />
        <path
          d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"
        />
      </svg>
      <svg
        v-else
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M20.5 15.1A8.2 8.2 0 0 1 8.9 3.5 8.7 8.7 0 1 0 20.5 15.1Z" />
      </svg>
      <template #fallback>
        <span class="theme-fallback" aria-hidden="true" />
      </template>
    </ClientOnly>
  </button>
</template>
