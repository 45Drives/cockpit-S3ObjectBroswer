<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[9999]">
      <!-- click-catcher -->
      <div
        class="absolute inset-0"
        @click="emitClose"
        @contextmenu.prevent="emitClose"
      ></div>

      <!-- menu panel -->
      <Menu as="div" class="absolute" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }">
        <MenuItems
          static
          class="min-w-[220px] overflow-hidden rounded-md border border-default bg-default shadow-lg outline-none"
        >
          <div class="py-1">
            <MenuItem v-slot="{ active }">
              <button
                type="button"
                class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'"
                @click="doAction('download')"
              >
                Download
              </button>
            </MenuItem>

            <MenuItem v-slot="{ active }">
              <button
                type="button"
                class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'"
                @click="doAction('copy')"
              >
                Copy key
              </button>
            </MenuItem>

            <div class="my-1 h-px bg-default"></div>

            <MenuItem v-slot="{ active }">
              <button
                type="button"
                class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'"
                @click="doAction('rename')"
              >
                Rename
              </button>
            </MenuItem>

            <MenuItem v-slot="{ active }">
              <button
                type="button"
                class="block w-full px-4 py-2 text-left text-sm "
                :class="active ? 'bg-accent text-default' : 'text-muted'"
                @click="doAction('delete')"
              >
                Delete
              </button>
            </MenuItem>
          </div>
        </MenuItems>
      </Menu>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Menu, MenuItem, MenuItems } from "@headlessui/vue";

export type MenuAction = "download" | "delete" | "rename" | "copy";
export type MenuPos = { x: number; y: number };

const props = defineProps<{
  open: boolean;
  pos: MenuPos;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "action", action: MenuAction): void;
}>();

function emitClose() {
  emit("close");
}

function doAction(action: MenuAction) {
  emit("action", action);
  emit("close");
}
</script>
