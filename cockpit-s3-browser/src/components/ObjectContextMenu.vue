<!-- src/components/ObjectContextMenu.vue -->
<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[9999]">
      <div class="absolute inset-0" @click="emitClose" @contextmenu.prevent="emitClose"></div>

      <Menu as="div" class="absolute" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }">
        <MenuItems
          static
          class="min-w-[220px] overflow-hidden rounded-md border border-default bg-default shadow-lg outline-none"
        >
          <div class="py-1">
            <!-- OBJECTS MODE -->
            <template v-if="mode === 'objects'">
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

              <div class="my-1 h-px bg-default"></div>

              <MenuItem v-slot="{ active }">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :class="active ? 'bg-accent text-default' : 'text-muted'"
                  @click="doAction('copy')"
                >
                  Copy
                </button>
              </MenuItem>

              <MenuItem v-slot="{ active }">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :class="active ? 'bg-accent text-default' : 'text-muted'"
                  @click="doAction('cut')"
                >
                  Cut
                </button>
              </MenuItem>

              <MenuItem v-slot="{ active }" :disabled="!canPaste">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :disabled="!canPaste"
                  :class="[
                    !canPaste
                      ? 'opacity-50 cursor-not-allowed text-muted'
                      : active
                        ? 'bg-accent text-default'
                        : 'text-muted',
                  ]"
                  @click="canPaste && doAction('paste')"
                >
                  Paste
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
                  class="block w-full px-4 py-2 text-left text-sm"
                  :class="active ? 'bg-accent text-default' : 'text-muted'"
                  @click="doAction('delete')"
                >
                  Delete
                </button>
              </MenuItem>

              <MenuItem v-slot="{ active }">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :class="active ? 'bg-accent text-default' : 'text-muted'"
                  @click="doAction('tags')"
                >
                  Edit object tags
                </button>
              </MenuItem>

              <MenuItem v-slot="{ active }">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :class="active ? 'bg-accent text-default' : 'text-muted'"
                  @click="doAction('storageClass')"
                >
                  Storage class
                </button>
              </MenuItem>
            </template>

            <!-- VERSIONS MODE -->
            <template v-else>
              <MenuItem v-slot="{ active }" :disabled="!isEnabled('download')">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :disabled="!isEnabled('download')"
                  :class="btnClass(active, isEnabled('download'))"
                  @click="isEnabled('download') && doAction('download')"
                >
                  Download
                </button>
              </MenuItem>

              <MenuItem v-slot="{ active }" :disabled="!isEnabled('rollback')">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :disabled="!isEnabled('rollback')"
                  :class="btnClass(active, isEnabled('rollback'))"
                  @click="isEnabled('rollback') && doAction('rollback')"
                >
                  Rollback to this version
                </button>
              </MenuItem>

              <div class="my-1 h-px bg-default"></div>

              <MenuItem v-slot="{ active }" :disabled="!isEnabled('delete')">
                <button
                  type="button"
                  class="block w-full px-4 py-2 text-left text-sm"
                  :disabled="!isEnabled('delete')"
                  :class="btnClass(active, isEnabled('delete'))"
                  @click="isEnabled('delete') && doAction('delete')"
                >
                  Delete version
                </button>
              </MenuItem>
            </template>
          </div>
        </MenuItems>
      </Menu>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Menu, MenuItem, MenuItems } from "@headlessui/vue";

export type MenuMode = "objects" | "versions";

export type MenuAction =
  | "download"
  | "delete"
  | "rename"
  | "copy"
  | "paste"
  | "cut"
  | "tags"
  | "storageClass"
  | "rollback"

export type MenuPos = { x: number; y: number };

const props = withDefaults(
  defineProps<{
    open: boolean;
    pos: MenuPos;
    mode?: MenuMode;
    canPaste?: boolean;

    // used in versions mode to enable/disable items per-row
    enabled?: Partial<Record<MenuAction, boolean>>;
  }>(),
  {
    mode: "objects",
    canPaste: false,
    enabled: () => ({}),
  },
);

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

function isEnabled(action: MenuAction) {
  const v = props.enabled?.[action];
  return v == null ? true : Boolean(v);
}

function btnClass(active: boolean, enabled: boolean) {
  if (!enabled) return "opacity-50 cursor-not-allowed text-muted";
  return active ? "bg-accent text-default" : "text-muted";
}
</script>
