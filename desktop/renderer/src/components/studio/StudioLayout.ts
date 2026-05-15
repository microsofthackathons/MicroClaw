/**
 * Layout constants for the Studio pixel workspace.
 * Ported from Star-Office-UI/frontend/layout.js.
 */

/** Base path for studio assets in the Vite public directory. */
const BASE_URL = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;
export const ASSET_BASE = `${BASE_URL}studio`;

/** Canvas dimensions. */
export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;

// ── Area coordinates (where agents move to based on state) ──

export const AREAS = {
  breakroom: { x: 800, y: 270 },
  desk: { x: 217, y: 333 },
  serverRoom: { x: 1021, y: 200 },
  bugCorner: { x: 1066, y: 220 },
  coffeeArea: { x: 659, y: 397 },
  entrance: { x: 640, y: 550 },
} as const;

/** Map agent state → target area. */
export const STATE_AREA_MAP: Record<string, keyof typeof AREAS> = {
  idle: "breakroom",
  writing: "desk",
  researching: "serverRoom",
  executing: "desk",
  syncing: "serverRoom",
  error: "bugCorner",
};

// ── Furniture / decoration positions ──

export interface FurnitureConfig {
  key: string;
  x: number;
  y: number;
  depth: number;
  scale?: number;
}

export const FURNITURE: FurnitureConfig[] = [
  { key: "desk_v2", x: 218, y: 417, depth: 1000 },
  { key: "coffee_machine", x: 659, y: 397, depth: 99 },
  { key: "serverroom", x: 1021, y: 142, depth: 2 },
  { key: "plants", x: 565, y: 178, depth: 5 },
  { key: "plants", x: 240, y: 185, depth: 5 },
  { key: "plants", x: 977, y: 496, depth: 5 },
  { key: "cats", x: 94, y: 557, depth: 2000 },
  { key: "posters", x: 252, y: 66, depth: 4 },
  { key: "flowers", x: 310, y: 390, depth: 1100, scale: 0.8 },
];

// ── Sofa config (state-dependent: sofa_busy when idle, sofa_idle when active) ──

export const SOFA_CONFIG = {
  x: 800,
  y: 270,
  depth: 10,
  origin: { x: 0.5, y: 0.5 },
};

// ── Star working sprite config (hidden by default, shown at desk when active) ──

export const STAR_WORKING_CONFIG = {
  x: 217,
  y: 333,
  depth: 900,
  scale: 1.0,
  origin: { x: 0.5, y: 0.5 },
};

// ── State-dependent effect sprites (hidden by default) ──

export const ERROR_BUG_CONFIG = {
  x: 1007,
  y: 221,
  depth: 50,
  scale: 0.9,
  pingPong: { leftX: 1007, rightX: 1111, speed: 0.6 },
};

export const SYNC_ANIM_CONFIG = {
  x: 1157,
  y: 592,
  depth: 40,
};

// ── Spritesheet frame configurations ──

export interface SpriteConfig {
  key: string;
  /** Filename (without extension). Extension resolved at runtime (webp vs png). */
  file: string;
  frameWidth: number;
  frameHeight: number;
  /** Total frame count. If undefined, auto-detected from image dimensions. */
  frameCount?: number;
  /** For grid-based spritesheets: columns in the grid. */
  columns?: number;
}

export const SPRITES: SpriteConfig[] = [
  // Strip format (all frames in one row)
  {
    key: "star_idle",
    file: "star-idle-spritesheet",
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 48,
    columns: 8,
  },
  {
    key: "serverroom",
    file: "serverroom-spritesheet",
    frameWidth: 180,
    frameHeight: 251,
    frameCount: 40,
  },

  // Grid format (rows × columns of square frames)
  {
    key: "star_working",
    file: "star-working-spritesheet-grid",
    frameWidth: 300,
    frameHeight: 300,
    frameCount: 38,
  },
  { key: "plants", file: "plants-spritesheet", frameWidth: 160, frameHeight: 160, frameCount: 16 },
  { key: "cats", file: "cats-spritesheet", frameWidth: 160, frameHeight: 160, frameCount: 16 },
  {
    key: "coffee_machine",
    file: "coffee-machine-spritesheet",
    frameWidth: 230,
    frameHeight: 230,
    frameCount: 96,
    columns: 12,
  },
  {
    key: "posters",
    file: "posters-spritesheet",
    frameWidth: 160,
    frameHeight: 160,
    frameCount: 32,
    columns: 4,
  },
  {
    key: "error_bug",
    file: "error-bug-spritesheet-grid",
    frameWidth: 220,
    frameHeight: 220,
    frameCount: 72,
    columns: 8,
  },
  {
    key: "flowers",
    file: "flowers-spritesheet",
    frameWidth: 128,
    frameHeight: 128,
    frameCount: 16,
    columns: 4,
  },
  {
    key: "sync_anim",
    file: "sync-animation-spritesheet-grid",
    frameWidth: 256,
    frameHeight: 256,
    frameCount: 49,
    columns: 7,
  },
];

/**
 * Individual poster images loaded on top of the spritesheet.
 * Each file should be 160×160 webp with the poster artwork centred and
 * transparent padding around it (matching the spritesheet frame layout).
 *
 * To add a new poster:
 *   1. Drop `poster-xxx.webp` into `public/studio/`
 *   2. Append `"poster-xxx"` here.
 */
export const EXTRA_POSTERS: string[] = ["poster-microsoft", "poster-bing"];

/** Static images (non-animated). */
export const STATIC_IMAGES: { key: string; file: string }[] = [
  { key: "studio_bg", file: "office_bg_small" },
  { key: "sofa_idle", file: "sofa-idle" },
  { key: "desk_v2", file: "desk-v2" },
];

// ── Agent sprite depth ──

export const AGENT_DEPTH = 20;
export const GUEST_AGENT_DEPTH = 28;

// ── State → animation key mapping ──

export const STATE_ANIMATION_MAP: Record<string, string> = {
  idle: "star_idle",
  writing: "star_working",
  researching: "star_working",
  executing: "star_working",
  syncing: "star_working",
  error: "star_idle", // Use idle sprite with a tint for error
};
