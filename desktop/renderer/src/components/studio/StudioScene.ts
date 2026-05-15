/**
 * Phaser scene for the Studio pixel workspace.
 * Ported and rewritten from Star-Office-UI/frontend/game.js.
 */
import Phaser from "phaser";
import {
  ASSET_BASE,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  SPRITES,
  STATIC_IMAGES,
  FURNITURE,
  AREAS,
  GUEST_AGENT_DEPTH,
  ERROR_BUG_CONFIG,
  SYNC_ANIM_CONFIG,
  SOFA_CONFIG,
  STAR_WORKING_CONFIG,
  EXTRA_POSTERS,
} from "./StudioLayout";
import { AgentSprite } from "./AgentSprite";
import { useStudioStore, type StudioAgentState } from "../../stores/studio";

export class StudioScene extends Phaser.Scene {
  private mainAgentSprite: AgentSprite | null = null;
  private guestSprites: Map<string, AgentSprite> = new Map();
  private lastMainState: string = "";
  private lastMainDetail: string = "";
  /** Error bug sprite — only visible during error state. */
  private errorBugSprite: Phaser.GameObjects.Sprite | null = null;
  private errorBugDir: number = 1;
  /** Sync animation sprite — only visible during syncing state. */
  private syncAnimSprite: Phaser.GameObjects.Sprite | null = null;
  /** Sofa sprite — toggles between sofa_busy (idle) and sofa_idle (active). */
  private sofaSprite: Phaser.GameObjects.Sprite | null = null;
  /** Serverroom sprite — animated when non-idle, static frame 0 when idle. */
  private serverroomSprite: Phaser.GameObjects.Sprite | null = null;
  /** Star working sprite — hidden by default, shown at desk when writing/executing/researching. */
  private starWorkingSprite: Phaser.GameObjects.Sprite | null = null;

  constructor() {
    super({ key: "StudioScene" });
  }

  private resolveExt(): string {
    return "webp";
  }

  preload() {
    // Load static images
    for (const img of STATIC_IMAGES) {
      const ext = this.resolveExt();
      this.load.image(img.key, `${ASSET_BASE}/${img.file}.${ext}`);
    }

    // Load spritesheets
    for (const sprite of SPRITES) {
      const ext = this.resolveExt();
      const config: Phaser.Types.Loader.FileTypes.ImageFrameConfig = {
        frameWidth: sprite.frameWidth,
        frameHeight: sprite.frameHeight,
        margin: 0,
        spacing: 0,
      };
      this.load.spritesheet(sprite.key, `${ASSET_BASE}/${sprite.file}.${ext}`, config);
    }

    // Load individual extra poster images
    for (const name of EXTRA_POSTERS) {
      const ext = this.resolveExt();
      this.load.image(`poster_extra_${name}`, `${ASSET_BASE}/${name}.${ext}`);
    }

    // Progress callback
    this.load.on("progress", (value: number) => {
      try {
        const store = useStudioStore();
        store.mainAgent.progress = Math.round(value * 100);
      } catch {
        /* store may not be ready */
      }
    });

    // Handle load errors gracefully
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      console.warn(`[StudioScene] Failed to load: "${file.key}"`);
    });
  }

  create() {
    const studioStore = useStudioStore();

    // Background
    if (this.textures.exists("studio_bg")) {
      const bg = this.add.image(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, "studio_bg");
      bg.setDisplaySize(CANVAS_WIDTH, CANVAS_HEIGHT);
      bg.setDepth(0);
    } else {
      this.cameras.main.setBackgroundColor("#2d2d3d");
    }

    // ── Sofa (state-dependent: sofa_busy when idle, sofa_idle when active) ──
    {
      const cfg = SOFA_CONFIG;
      const hasBusy = this.textures.exists("sofa_busy");
      const hasIdle = this.textures.exists("sofa_idle");
      if (hasBusy) {
        if (!this.anims.exists("sofa_busy")) {
          this.anims.create({
            key: "sofa_busy",
            frames: this.anims.generateFrameNumbers("sofa_busy", { start: 0, end: 47 }),
            frameRate: 8,
            repeat: -1,
          });
        }
        this.sofaSprite = this.add.sprite(cfg.x, cfg.y, "sofa_busy");
        this.sofaSprite.setOrigin(cfg.origin.x, cfg.origin.y);
        this.sofaSprite.setDepth(cfg.depth);
        this.sofaSprite.play("sofa_busy");
      } else if (hasIdle) {
        this.sofaSprite = this.add.sprite(cfg.x, cfg.y, "sofa_idle");
        this.sofaSprite.setOrigin(cfg.origin.x, cfg.origin.y);
        this.sofaSprite.setDepth(cfg.depth);
      }
    }

    /** Only coffee_machine loops forever. Serverroom is state-dependent. */
    const ALWAYS_ANIMATED = new Set(["coffee_machine"]);

    const ANIM_RATES: Record<string, number> = {
      coffee_machine: 6,
    };

    // ── Place furniture ──
    for (const item of FURNITURE) {
      if (!this.textures.exists(item.key)) {
        console.warn(`[StudioScene] Texture missing for furniture: ${item.key}`);
        continue;
      }
      const obj = this.add.sprite(item.x, item.y, item.key);
      obj.setOrigin(0.5, 0.5);
      obj.setDepth(item.depth);
      if (item.scale) obj.setScale(item.scale);

      const spriteConf = SPRITES.find((s) => s.key === item.key);

      if (item.key === "serverroom") {
        this.serverroomSprite = obj;
        if (!this.anims.exists("serverroom_on")) {
          this.anims.create({
            key: "serverroom_on",
            frames: this.anims.generateFrameNumbers("serverroom", { start: 0, end: 39 }),
            frameRate: 6,
            repeat: -1,
          });
        }
        obj.anims.stop();
        obj.setFrame(0); // idle = off
      } else if (
        ALWAYS_ANIMATED.has(item.key) &&
        spriteConf?.frameCount &&
        spriteConf.frameCount > 1
      ) {
        const animKey = `${item.key}_anim`;
        if (!this.anims.exists(animKey)) {
          this.anims.create({
            key: animKey,
            frames: this.anims.generateFrameNumbers(item.key, {
              start: 0,
              end: spriteConf.frameCount - 1,
            }),
            frameRate: ANIM_RATES[item.key] || 8,
            repeat: -1,
          });
        }
        obj.play(animKey);
      } else if (item.key === "posters" && spriteConf?.frameCount) {
        // Posters: merge spritesheet frames with individual extra poster images
        const baseFrames = spriteConf.frameCount;
        const extras = EXTRA_POSTERS.map((n) => `poster_extra_${n}`).filter((k) =>
          this.textures.exists(k),
        );
        const totalCount = baseFrames + extras.length;

        let posterIndex = 0;
        const showPoster = (idx: number) => {
          if (idx < extras.length) {
            obj.setTexture(extras[idx]);
          } else {
            obj.setTexture("posters");
            obj.setFrame(idx - extras.length);
          }
        };

        showPoster(posterIndex);
        obj.setInteractive({ useHandCursor: true });
        obj.on("pointerdown", () => {
          if (studioStore.uiOverlayPointerBlock) return;
          posterIndex = (posterIndex + 1) % totalCount;
          showPoster(posterIndex);
        });
      } else if (spriteConf?.frameCount && spriteConf.frameCount > 1) {
        // Static decoration — random frame, click to change
        const totalFrames = Math.min(spriteConf.frameCount, 16); // cap to 16 like original
        obj.setFrame(Math.floor(Math.random() * totalFrames));
        obj.setInteractive({ useHandCursor: true });
        obj.on("pointerdown", () => {
          if (studioStore.uiOverlayPointerBlock) return;
          obj.setFrame(Math.floor(Math.random() * totalFrames));
        });
      }
    }

    // ── Create animations ──
    this.createAgentAnimations();

    // ── Star working sprite (hidden, at desk, shown when active) ──
    if (this.textures.exists("star_working")) {
      const cfg = STAR_WORKING_CONFIG;
      this.starWorkingSprite = this.add.sprite(cfg.x, cfg.y, "star_working", 0);
      this.starWorkingSprite.setOrigin(cfg.origin.x, cfg.origin.y);
      this.starWorkingSprite.setDepth(cfg.depth);
      this.starWorkingSprite.setScale(cfg.scale);
      this.starWorkingSprite.setVisible(false);
    }

    // ── Main agent ──
    const startArea = AREAS.breakroom;
    this.mainAgentSprite = new AgentSprite(this, startArea.x, startArea.y, "Star", "star_idle");
    this.mainAgentSprite.setNameVisible(false);
    if (this.anims.exists("star_idle")) {
      this.mainAgentSprite.getSprite().play("star_idle");
    }

    // ── State-dependent effects (hidden by default) ──
    this.createStateEffects();
  }

  private createStateEffects() {
    // Error bug — only visible during error state, ping-pongs left↔right
    if (this.textures.exists("error_bug")) {
      const cfg = ERROR_BUG_CONFIG;
      if (!this.anims.exists("error_bug")) {
        this.anims.create({
          key: "error_bug",
          frames: this.anims.generateFrameNumbers("error_bug", { start: 0, end: 71 }),
          frameRate: 12,
          repeat: -1,
        });
      }
      this.errorBugSprite = this.add.sprite(cfg.x, cfg.y, "error_bug", 0);
      this.errorBugSprite.setOrigin(0.5, 0.5);
      this.errorBugSprite.setDepth(cfg.depth);
      this.errorBugSprite.setScale(cfg.scale);
      this.errorBugSprite.setVisible(false);
      this.errorBugSprite.play("error_bug");
    }

    // Sync animation — only visible during syncing state
    if (this.textures.exists("sync_anim")) {
      const cfg = SYNC_ANIM_CONFIG;
      if (!this.anims.exists("sync_anim")) {
        this.anims.create({
          key: "sync_anim",
          frames: this.anims.generateFrameNumbers("sync_anim", { start: 1, end: 48 }),
          frameRate: 12,
          repeat: -1,
        });
      }
      this.syncAnimSprite = this.add.sprite(cfg.x, cfg.y, "sync_anim", 0);
      this.syncAnimSprite.setOrigin(0.5, 0.5);
      this.syncAnimSprite.setDepth(cfg.depth);
      this.syncAnimSprite.setVisible(false);
    }
  }

  private createAgentAnimations() {
    const animConfigs = [
      { key: "star_idle", frames: 48, frameRate: 8 },
      { key: "star_working", frames: 38, frameRate: 12 },
    ];

    for (const conf of animConfigs) {
      if (this.textures.exists(conf.key) && !this.anims.exists(conf.key)) {
        this.anims.create({
          key: conf.key,
          frames: this.anims.generateFrameNumbers(conf.key, {
            start: 0,
            end: conf.frames - 1,
          }),
          frameRate: conf.frameRate,
          repeat: -1,
        });
      }
    }
  }

  update() {
    const store = useStudioStore();
    const agentState = store.mainAgent.state;
    const agentDetail = store.mainAgent.detail || "";
    const stateChanged = agentState !== this.lastMainState;
    const detailChanged = agentDetail !== this.lastMainDetail;

    // ── State change handling ──
    if (stateChanged || detailChanged) {
      this.lastMainDetail = agentDetail;

      if (this.mainAgentSprite) {
        this.mainAgentSprite.setState(agentState);
      }

      if (stateChanged) {
        this.lastMainState = agentState;

        // Sofa: sofa_busy (animated) when idle, sofa_idle (static) when active
        if (this.sofaSprite) {
          if (agentState === "idle") {
            if (this.textures.exists("sofa_busy")) {
              this.sofaSprite.setTexture("sofa_busy");
              this.sofaSprite.play("sofa_busy", true);
            }
          } else {
            if (this.sofaSprite.anims.isPlaying) this.sofaSprite.anims.stop();
            if (this.textures.exists("sofa_idle")) {
              this.sofaSprite.setTexture("sofa_idle");
            }
          }
        }

        // Serverroom: animated when non-idle, static frame 0 when idle
        if (this.serverroomSprite) {
          if (agentState === "idle") {
            this.serverroomSprite.anims.stop();
            this.serverroomSprite.setFrame(0);
          } else {
            if (!this.serverroomSprite.anims.isPlaying) {
              this.serverroomSprite.play("serverroom_on", true);
            }
          }
        }

        // Star working sprite: visible at desk when writing/executing/researching
        const showWorking =
          agentState === "writing" || agentState === "executing" || agentState === "researching";
        if (this.starWorkingSprite) {
          if (showWorking) {
            this.starWorkingSprite.setVisible(true);
            if (this.anims.exists("star_working")) {
              this.starWorkingSprite.play("star_working", true);
            }
          } else {
            this.starWorkingSprite.setVisible(false);
            if (this.starWorkingSprite.anims.isPlaying) this.starWorkingSprite.anims.stop();
          }
        }

        // Main agent: only visible when idle
        const hideAgent = showWorking || agentState === "error" || agentState === "syncing";
        if (this.mainAgentSprite) {
          if (hideAgent) {
            this.mainAgentSprite.getSprite().setVisible(false);
          } else {
            this.mainAgentSprite.getSprite().setVisible(true);
          }
        }
      }

      if (this.mainAgentSprite) {
        if (agentDetail) {
          this.mainAgentSprite.showBubble(agentDetail);
        } else if (detailChanged) {
          this.mainAgentSprite.clearBubble();
        }
      }
    }

    // Update main agent sprite position tracking
    if (this.mainAgentSprite) {
      this.mainAgentSprite.update();
    }

    // ── State-dependent effects ──

    // Error bug: visible only during error state, ping-pong left↔right
    if (this.errorBugSprite) {
      if (agentState === "error") {
        this.errorBugSprite.setVisible(true);
        if (!this.errorBugSprite.anims.isPlaying) {
          this.errorBugSprite.play("error_bug", true);
        }
        const pp = ERROR_BUG_CONFIG.pingPong;
        this.errorBugSprite.x += pp.speed * this.errorBugDir;
        if (this.errorBugSprite.x >= pp.rightX) {
          this.errorBugSprite.x = pp.rightX;
          this.errorBugDir = -1;
        } else if (this.errorBugSprite.x <= pp.leftX) {
          this.errorBugSprite.x = pp.leftX;
          this.errorBugDir = 1;
        }
      } else {
        this.errorBugSprite.setVisible(false);
        if (this.errorBugSprite.anims.isPlaying) this.errorBugSprite.anims.stop();
      }
    }

    // Sync animation: visible only during syncing state
    if (this.syncAnimSprite) {
      if (agentState === "syncing") {
        this.syncAnimSprite.setVisible(true);
        if (!this.syncAnimSprite.anims.isPlaying) {
          this.syncAnimSprite.play("sync_anim", true);
        }
      } else {
        this.syncAnimSprite.setVisible(false);
        if (this.syncAnimSprite.anims.isPlaying) this.syncAnimSprite.anims.stop();
      }
    }

    // Keep name label / bubble aligned with whichever protagonist form is visible.
    if (this.mainAgentSprite) {
      const showWorking =
        agentState === "writing" || agentState === "executing" || agentState === "researching";
      if (showWorking && this.starWorkingSprite?.visible) {
        this.mainAgentSprite.setOverlayAnchor(this.starWorkingSprite.x, this.starWorkingSprite.y);
      } else if (agentState === "error" && this.errorBugSprite?.visible) {
        this.mainAgentSprite.setOverlayAnchor(this.errorBugSprite.x, this.errorBugSprite.y);
      } else if (agentState === "syncing" && this.syncAnimSprite?.visible) {
        this.mainAgentSprite.setOverlayAnchor(this.syncAnimSprite.x, this.syncAnimSprite.y);
      } else {
        this.mainAgentSprite.clearOverlayAnchor();
      }
    }

    // Sync guest agents
    this.syncGuestAgents(store.guestAgents);
  }

  private syncGuestAgents(guests: { id: string; name: string; state: StudioAgentState }[]) {
    const currentIds = new Set(guests.map((g) => g.id));

    // Remove departed guests
    for (const [id, sprite] of this.guestSprites) {
      if (!currentIds.has(id)) {
        sprite.destroy();
        this.guestSprites.delete(id);
      }
    }

    // Add or update guests
    for (let i = 0; i < guests.length; i++) {
      const guest = guests[i];
      let sprite = this.guestSprites.get(guest.id);
      if (!sprite) {
        // Offset guests slightly from the main areas
        const area = AREAS.entrance;
        sprite = new AgentSprite(
          this,
          area.x + (i % 3) * 60 - 60,
          area.y + Math.floor(i / 3) * 40,
          guest.name,
          "star_idle",
        );
        sprite.getSprite().setDepth(GUEST_AGENT_DEPTH);
        sprite.getSprite().setAlpha(0.85);
        sprite.getSprite().setScale(0.6);
        this.guestSprites.set(guest.id, sprite);
      }
      sprite.setState(guest.state);
      sprite.setName(guest.name);
      sprite.update();
    }
  }
}
