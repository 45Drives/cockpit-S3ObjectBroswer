<!-- src/components/ObjectContextMenu.vue -->
<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[9999]">
      <div class="absolute inset-0" @click="emitClose" @contextmenu.prevent="emitClose"></div>

      <Menu as="div" class="fixed" :style="menuStyle">
        <MenuItems ref="itemsEl" static
          class="min-w-[220px] overflow-hidden rounded-md border border-default bg-default shadow-lg outline-none"
          :style="{ visibility: measured ? 'visible' : 'hidden' }">
          <div class="py-1">
            <!-- OBJECTS MODE -->
            <template v-if="mode === 'objects'">
              <MenuItem v-slot="{ active }">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'" @click="doAction('download')">
                Download
              </button>
              </MenuItem>

              <div class="my-1 h-px bg-default"></div>

              <MenuItem v-slot="{ active }">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'" @click="doAction('copy')">
                Copy
              </button>
              </MenuItem>

              <MenuItem v-slot="{ active }">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'" @click="doAction('cut')">
                Cut
              </button>
              </MenuItem>

              <MenuItem v-slot="{ active }" :disabled="!canPaste">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm" :disabled="!canPaste" :class="[
                !canPaste
                  ? 'opacity-50 cursor-not-allowed text-muted'
                  : active
                    ? 'bg-accent text-default'
                    : 'text-muted',
              ]" @click="canPaste && doAction('paste')">
                Paste
              </button>
              </MenuItem>

              <div class="my-1 h-px bg-default"></div>

              <MenuItem v-slot="{ active }">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'" @click="doAction('rename')">
                Rename
              </button>
              </MenuItem>

              <MenuItem v-slot="{ active }">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'" @click="doAction('delete')">
                Delete
              </button>
              </MenuItem>

              <MenuItem v-slot="{ active }">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'" @click="doAction('tags')">
                Edit object tags
              </button>
              </MenuItem>

              <MenuItem v-slot="{ active }">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm"
                :class="active ? 'bg-accent text-default' : 'text-muted'" @click="doAction('storageClass')">
                Storage class
              </button>
              </MenuItem>
            </template>

            <!-- VERSIONS MODE -->
            <template v-else>
              <MenuItem v-slot="{ active }" :disabled="!isEnabled('download')">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm" :disabled="!isEnabled('download')"
                :class="btnClass(active, isEnabled('download'))" @click="isEnabled('download') && doAction('download')">
                Download
              </button>
              </MenuItem>

              <MenuItem v-slot="{ active }" :disabled="!isEnabled('rollback')">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm" :disabled="!isEnabled('rollback')"
                :class="btnClass(active, isEnabled('rollback'))" @click="isEnabled('rollback') && doAction('rollback')">
                Rollback to this version
              </button>
              </MenuItem>

              <div class="my-1 h-px bg-default"></div>

              <MenuItem v-slot="{ active }" :disabled="!isEnabled('delete')">
              <button type="button" class="block w-full px-4 py-2 text-left text-sm" :disabled="!isEnabled('delete')"
                :class="btnClass(active, isEnabled('delete'))" @click="isEnabled('delete') && doAction('delete')">
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

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
  | "rollback";

export type MenuPos = { x: number; y: number };

const props = withDefaults(
  defineProps<{
    open: boolean;
    pos: MenuPos;
    mode?: MenuMode;
    canPaste?: boolean;
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

// ---- positioning (flip up + clamp to viewport) ----

const itemsEl = ref<any>(null);
const measured = ref(false);
const menuSize = ref({ w: 0, h: 0 });

const viewport = ref({ w: window.innerWidth, h: window.innerHeight });

function onResize() {
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
}
window.addEventListener("resize", onResize);

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  ro?.disconnect();
  ro = null;
});

function getItemsDomEl(): HTMLElement | null {
  const v = itemsEl.value;
  const el = (v && (v.$el as HTMLElement)) || v;
  return el instanceof HTMLElement ? el : null;
}

function measureMenu() {
  const el = getItemsDomEl();
  if (!el) return;
  const r = el.getBoundingClientRect();
  menuSize.value = { w: r.width || 220, h: r.height || 0 };
  measured.value = (menuSize.value.h || 0) > 0;
}

watch(
  () => [props.open, props.pos.x, props.pos.y, props.mode] as const,
  async ([open]) => {
    if (!open) return;
    measured.value = false;
    await nextTick();
    measureMenu();
    await nextTick();
    measureMenu();
  },
);

let ro: ResizeObserver | null = null;

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      ro?.disconnect();
      ro = null;
      return;
    }

    await nextTick();
    measureMenu();

    ro?.disconnect();
    ro = new ResizeObserver(() => measureMenu());
    const el = getItemsDomEl();
    if (el) ro.observe(el);
  },
  { immediate: true },
);

const menuStyle = computed(() => {
  const EDGE_PAD = 8;        // keep away from edges (left/right/top)
  const BOTTOM_GUTTER = 24;  // extra breathing room from bottom
  const OFFSET = 2;

  const w = menuSize.value.w || 220;
  const h = menuSize.value.h || 240;

  const vw = viewport.value.w;
  const vh = viewport.value.h;

  // Start opening down-right
  let x = props.pos.x + OFFSET;
  let y = props.pos.y + OFFSET;

  // Clamp X (prefer right; if overflow, shift left)
  if (x + w + EDGE_PAD > vw) x = vw - w - EDGE_PAD;
  if (x < EDGE_PAD) x = EDGE_PAD;

  // Flip logic with bottom gutter:
  // If not enough space below (considering gutter), open upward if possible.
  const spaceBelow = vh - props.pos.y - EDGE_PAD;
  const spaceAbove = props.pos.y - EDGE_PAD;

  const needsFlip = spaceBelow < h + BOTTOM_GUTTER;
  const canFlip = spaceAbove >= h + EDGE_PAD;

  if (needsFlip && canFlip) {
    y = props.pos.y - h - OFFSET;
  }

  // Clamp Y with bottom gutter (so it never sits too close to bottom)
  const maxY = Math.max(EDGE_PAD, vh - h - BOTTOM_GUTTER);
  if (y < EDGE_PAD) y = EDGE_PAD;
  if (y > maxY) y = maxY;

  return {
    left: `${Math.round(x)}px`,
    top: `${Math.round(y)}px`,
  };
});
</script>