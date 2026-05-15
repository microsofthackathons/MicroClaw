/**
 * Agent sprite management class for the Studio pixel workspace.
 */
import Phaser from "phaser";
import { AREAS, STATE_AREA_MAP, STATE_ANIMATION_MAP, AGENT_DEPTH } from "./StudioLayout";

const BUBBLE_OFFSET_Y = 118;
const BUBBLE_DEPTH = 5000;

export class AgentSprite {
  private scene: Phaser.Scene;
  private sprite: Phaser.GameObjects.Sprite;
  private nameText: Phaser.GameObjects.Text;
  private bubble: Phaser.GameObjects.Container | null = null;
  private bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: string = "idle";
  private overlayAnchor: { x: number; y: number } | null = null;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    name: string,
    textureKey: string = "star_idle",
  ) {
    this.scene = scene;

    this.sprite = scene.add.sprite(x, y, textureKey);
    this.sprite.setDepth(AGENT_DEPTH);
    this.sprite.setScale(1.0);
    this.sprite.setAlpha(0.95);

    this.nameText = scene.add.text(x, y + 50, name, {
      fontSize: "12px",
      fontFamily: "Arial, sans-serif",
      color: "#ffffff",
      backgroundColor: "#000000",
      padding: { left: 6, right: 6, top: 2, bottom: 2 },
      align: "center",
    });
    this.nameText.setOrigin(0.5, 0);
    this.nameText.setDepth(AGENT_DEPTH + 1);
    this.nameText.setAlpha(0.75);
  }

  /** Move agent to the area corresponding to a state. */
  moveTo(area: keyof typeof AREAS, duration: number = 600) {
    const target = AREAS[area];
    if (!target) return;

    this.scene.tweens.add({
      targets: this.sprite,
      x: target.x,
      y: target.y,
      duration,
      ease: "Power2",
    });
    this.scene.tweens.add({
      targets: this.nameText,
      x: target.x,
      y: target.y + 50,
      duration,
      ease: "Power2",
    });
  }

  /** Set agent state — moves to corresponding area and plays animation. */
  setState(state: string) {
    if (state === this.currentState) return;
    this.currentState = state;

    const area = STATE_AREA_MAP[state] || "breakroom";
    this.moveTo(area);

    const animKey = STATE_ANIMATION_MAP[state] || "star_idle";
    const animExists = this.scene.anims.exists(animKey);
    if (animExists) {
      this.sprite.play(animKey, true);
    } else {
      // Fallback: just set the texture
      if (this.scene.textures.exists(animKey)) {
        this.sprite.setTexture(animKey);
      }
    }

    // Error state: add red tint
    if (state === "error") {
      this.sprite.setTint(0xff6666);
    } else {
      this.sprite.clearTint();
    }
  }

  /** Show a temporary speech bubble. */
  showBubble(text: string, duration: number = 3000) {
    this.clearBubble();

    const truncated = text.length > 50 ? text.slice(0, 47) + "..." : text;
    const bubbleText = this.scene.add.text(0, 0, truncated, {
      fontSize: "12px",
      fontFamily: "ipix, ArkPixel, monospace",
      color: "#333333",
      align: "center",
      wordWrap: { width: 220, useAdvancedWrap: true },
      lineSpacing: 2,
    });
    bubbleText.setOrigin(0.5, 0.5);

    const paddingX = 14;
    const paddingY = 6;
    const boxW = Math.max(84, bubbleText.width + paddingX * 2);
    const boxH = Math.max(30, bubbleText.height + paddingY * 2);

    const shadow = this.scene.add.graphics();
    shadow.fillStyle(0x000000, 0.18);
    shadow.fillRoundedRect(-boxW / 2 + 2, -boxH / 2 + 2, boxW, boxH, 8);

    const bubbleShape = this.scene.add.graphics();
    bubbleShape.fillStyle(0xffffff, 0.95);
    bubbleShape.lineStyle(2, 0x888888, 1);
    bubbleShape.fillRoundedRect(-boxW / 2, -boxH / 2, boxW, boxH, 8);
    bubbleShape.strokeRoundedRect(-boxW / 2, -boxH / 2, boxW, boxH, 8);

    // Tail border + inner fill to mimic classic speech bubble pointer.
    bubbleShape.fillStyle(0x888888, 1);
    bubbleShape.fillTriangle(-6, boxH / 2 - 1, 6, boxH / 2 - 1, 0, boxH / 2 + 8);
    bubbleShape.fillStyle(0xffffff, 0.95);
    bubbleShape.fillTriangle(-5, boxH / 2 - 1, 5, boxH / 2 - 1, 0, boxH / 2 + 6);

    this.bubble = this.scene.add.container(this.sprite.x, this.sprite.y - BUBBLE_OFFSET_Y, [
      shadow,
      bubbleShape,
      bubbleText,
    ]);
    this.bubble.setDepth(BUBBLE_DEPTH);

    this.bubbleTimer = setTimeout(() => {
      this.clearBubble();
    }, duration);
  }

  clearBubble() {
    if (this.bubbleTimer) {
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = null;
    }
    if (this.bubble) {
      this.bubble.destroy();
      this.bubble = null;
    }
  }

  setOverlayAnchor(x: number, y: number) {
    this.overlayAnchor = { x, y };
  }

  clearOverlayAnchor() {
    this.overlayAnchor = null;
  }

  /** Update position of name text and bubble to follow sprite. */
  update() {
    const anchorX = this.overlayAnchor?.x ?? this.sprite.x;
    const anchorY = this.overlayAnchor?.y ?? this.sprite.y;

    if (this.nameText) {
      this.nameText.setPosition(anchorX, anchorY + 50);
    }
    if (this.bubble) {
      this.bubble.setPosition(anchorX, anchorY - BUBBLE_OFFSET_Y);
    }
  }

  /** Set the display name. */
  setName(name: string) {
    this.nameText.setText(name);
  }

  /** Toggle name label visibility. */
  setNameVisible(visible: boolean) {
    this.nameText.setVisible(visible);
  }

  /** Get the underlying Phaser sprite. */
  getSprite(): Phaser.GameObjects.Sprite {
    return this.sprite;
  }

  /** Clean up all game objects. */
  destroy() {
    this.clearBubble();
    this.overlayAnchor = null;
    this.nameText.destroy();
    this.sprite.destroy();
  }
}
