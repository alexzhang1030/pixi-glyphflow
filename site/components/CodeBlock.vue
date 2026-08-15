<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

import { useAsyncData } from "#app";

const props = withDefaults(
  defineProps<{
    code: string;
    language?: "bash" | "typescript";
    label?: string;
  }>(),
  {
    language: "typescript",
    label: "TypeScript",
  },
);

function hashKey(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(36);
}

const { data: highlighted } = await useAsyncData(
  `code-${hashKey(`${props.language}:${props.code}`)}`,
  async () => {
    if (!import.meta.server) return "";
    const { highlightCode } = await import("~/utils/highlighter");
    return highlightCode(props.code, props.language);
  },
);

const copied = ref(false);
let resetTimer: number | undefined;

async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code);
  } catch {
    return;
  }
  copied.value = true;
  if (resetTimer !== undefined) window.clearTimeout(resetTimer);
  resetTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1_500);
}

onBeforeUnmount(() => {
  if (resetTimer !== undefined) window.clearTimeout(resetTimer);
});
</script>

<template>
  <figure class="code-block">
    <figcaption class="code-toolbar">
      <span>{{ label }}</span>
      <button type="button" :aria-label="copied ? 'Code copied' : 'Copy code'" @click="copyCode">
        <span aria-live="polite">{{ copied ? "Copied" : "Copy" }}</span>
      </button>
    </figcaption>
    <div class="code-scroll" v-html="highlighted ?? ''" />
  </figure>
</template>
