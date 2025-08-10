import Phaser from "phaser";

// ---------- Config ----------
const DESIGN_WIDTH = 800;
const DESIGN_HEIGHT = 450;

// Colors
const BG_BULL = 0x0f1a12;  // warm-ish when price up
const BG_BEAR = 0x0f141a;  // cool-ish when price down
const CANDLE_BULL = 0x2ea043;
const CANDLE_BEAR = 0xf85149;

// Price fetch
const PRICE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const PRICE_INTERVAL_MS = 5000; // fetch every 5s

type Trend = "up" | "down" | "flat";

class RunnerScene extends Phaser.Scene {
  // actors
  private player!: Phaser.GameObjects.Arc & { body: Phaser.Physics.Arcade.Body };
  private ground!: Phaser.GameObjects.Rectangle & { body: Phaser.Physics.Arcade.StaticBody };
  private obstacles!: Phaser.Physics.Arcade.Group;

  // world/ui
  private groundY!: number;
  private score = 0;
  private scoreText!: Phaser.GameObjects.Text;

  // price ui/state
  private priceText!: Phaser.GameObjects.Text;
  private lastPrice: number | null = null;
  private curPrice: number | null = null;
  private priceTrend: Trend = "flat";
  private priceAcc = 0; // accumulator for fetch interval

  // gameplay tuning
  private speed = 180;
  private gapMin = 264;
  private gapMax = 308;
  private jumpVelocity = -630;
  private gravityY = 1400;

  // spawn via delta accumulator (no timers)
  private spawnDelay = 1200; // already +10% wider spacing
  private spawnAcc = 0;

  // state
  private gameOverShown = false;

  constructor() { super("Runner"); }

  create() {
    const { width, height } = this.scale;
    this.groundY = Math.floor(height * 0.85);

    // initial background by trend
    this.cameras.main.setBackgroundColor(BG_BEAR);

    // visual ground
    this.add.rectangle(0, this.groundY, width * 2, 2, 0x222833).setOrigin(0, 0.5);

    // real ground collider
    const groundRect = this.add.rectangle(width / 2, this.groundY + 6, width * 2, 12, 0x000000, 0);
    this.physics.add.existing(groundRect, true);
    this.ground = groundRect as any;

    // player
    const coin = this.add.circle(width * 0.25, this.groundY - 18, 18, 0xffb800);
    this.physics.add.existing(coin);
    coin.body.setGravityY(this.gravityY);
    coin.setDepth(5);
    this.player = coin as any;

    this.physics.add.collider(this.player, this.ground);

    // obstacles
    this.obstacles = this.physics.add.group();

    // UI: score (left)
    this.score = 0;
    this.scoreText = this.add.text(16, 16, "Score: 0", {
      fontSize: "20px", color: "#e6edf3", fontFamily: "monospace",
    });

    // UI: instruction (left)
    this.add.text(16, 42, "SPACE/Touch = Jump  |  Avoid to score up", {
      fontSize: "14px", color: "#8b949e", fontFamily: "monospace",
    });

    // UI: price (right)
    this.priceText = this.add.text(width - 16, 16, "BTC: …", {
      fontSize: "18px", color: "#e6edf3", fontFamily: "monospace",
    }).setOrigin(1, 0);

    // input
    this.input.keyboard!.on("keydown-SPACE", () => this.tryJump());
    this.input.on("pointerdown", () => this.tryJump());

    // overlap -> game over
    this.physics.add.overlap(this.player, this.obstacles, () => this.onGameOver());

    // focus
    this.game.canvas.setAttribute("tabindex", "0");
    this.game.canvas.focus();

    // reset runtime vars
    this.spawnAcc = 0;
    this.priceAcc = PRICE_INTERVAL_MS; // force immediate first fetch
    this.spawnDelay = 1200;            // keep 10% increased spacing
    this.speed = 180;
    this.gameOverShown = false;
  }

  // -------- Price handling (fetch every ~5s without timers) --------
  private async fetchPriceOnce() {
    try {
      const r = await fetch(PRICE_URL, { cache: "no-store" });
      const j = await r.json();
      const p = parseFloat(j.price);
      if (!isNaN(p)) {
        if (this.curPrice !== null) this.lastPrice = this.curPrice;
        this.curPrice = p;

        // trend detection
        if (this.lastPrice === null || this.curPrice === this.lastPrice) {
          this.priceTrend = "flat";
        } else if (this.curPrice > this.lastPrice) {
          this.priceTrend = "up";
        } else {
          this.priceTrend = "down";
        }

        // update UI + background by trend
        this.priceText.setText(`BTC: ${this.curPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`);
        this.cameras.main.setBackgroundColor(this.priceTrend === "up" ? BG_BULL : BG_BEAR);
      }
    } catch {
      // keep last shown price; optionally show "ERR"
      this.priceText.setText("BTC: fetch error");
    }
  }

  private tryJump() {
    if (this.gameOverShown) return;
    const b = this.player.body;
    if (b.blocked.down || b.touching.down) b.setVelocityY(this.jumpVelocity);
  }

  update(_: number, delta: number) {
    if (this.gameOverShown) return;

    // clamp to ground
    const b = this.player.body;
    if (b.y + b.height > this.groundY) {
      b.y = this.groundY - b.height;
      b.velocity.y = Math.max(0, b.velocity.y);
    }

    // ---- price fetch accumulator ----
    this.priceAcc += delta;
    if (this.priceAcc >= PRICE_INTERVAL_MS) {
      this.priceAcc = 0;
      // fire & forget; we don't await in update loop
      this.fetchPriceOnce();
    }

    // ---- obstacle spawn accumulator ----
    this.spawnAcc += delta;
    while (this.spawnAcc >= this.spawnDelay) {
      this.spawnAcc -= this.spawnDelay;
      this.spawnObstacle();
    }

    // move / cleanup / scoring / difficulty
    this.obstacles.children.each((obj) => {
      const body = (obj as any).body as Phaser.Physics.Arcade.Body;
      if (obj.x < -60) {
        if (!(obj as any)._scored) {
          this.score += 1;
          this.scoreText.setText(`Score: ${this.score}`);
          (obj as any)._scored = true;

          // ramp
          this.speed = Math.min(this.speed + 8, 420);
          this.spawnDelay = Math.max(this.spawnDelay - 10, 885); // keep your +10% min spacing
        }
        obj.destroy();
      } else {
        body.setVelocityX(-this.speed);
      }
    });

    if (this.player.y < -40) this.onGameOver();
  }

  private spawnObstacle() {
    const { width } = this.scale;
    const spawnX = width + 24;

    // decide bullish/bearish color by latest trend (fallback random if flat/unknown)
    let bullish: boolean;
    if (this.priceTrend === "up") bullish = true;
    else if (this.priceTrend === "down") bullish = false;
    else bullish = Math.random() < 0.5;

    const gapTop = Phaser.Math.Between(130, Math.max(170, this.groundY - 220));
    const gap = Phaser.Math.Between(this.gapMin, this.gapMax);

    // top candle
    const topHeight = Math.max(60, gapTop - 40);
    const top = this.add.rectangle(spawnX, topHeight / 2, 26, topHeight, bullish ? CANDLE_BULL : CANDLE_BEAR);
    this.physics.add.existing(top);
    (top.body as Phaser.Physics.Arcade.Body).setAllowGravity(false).setVelocityX(-this.speed);

    // bottom candle
    const bottomY = this.groundY;
    const bottomHeight = Math.max(80, bottomY - (gapTop + gap));
    const bottom = this.add.rectangle(spawnX, bottomY - bottomHeight / 2, 26, bottomHeight, bullish ? CANDLE_BULL : CANDLE_BEAR);
    this.physics.add.existing(bottom);
    (bottom.body as Phaser.Physics.Arcade.Body).setAllowGravity(false).setVelocityX(-this.speed);

    this.obstacles.addMultiple([top, bottom]);
  }

  private onGameOver() {
    if (this.gameOverShown) return;
    this.gameOverShown = true;

    // freeze obstacles (no global pause)
    this.obstacles.children.each((obj) => (obj as any).body?.setVelocity(0));

    const cx = this.scale.width / 2, cy = this.scale.height / 2;
    this.add.text(cx, cy - 10, `GAME OVER\nScore: ${this.score}`, {
      fontSize: "28px", color: "#e6edf3", fontStyle: "bold", align: "center",
    }).setOrigin(0.5);
    this.add.text(cx, cy + 64, "Press ANY key or TAP anywhere to restart", {
      fontSize: "14px", color: "#8b949e", align: "center",
    }).setOrigin(0.5);

    // full-screen catcher → restart fresh scene
    const blocker = this.add.rectangle(cx, cy, this.scale.width, this.scale.height, 0x000000, 0)
      .setInteractive({ useHandCursor: true });
    const doRestart = () => this.scene.start("Runner");
    blocker.once("pointerdown", doRestart);
    this.input.keyboard!.once("keydown", doRestart);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  width: DESIGN_WIDTH,
  height: DESIGN_HEIGHT,
  backgroundColor: "#0e1116",
  parent: document.body,
  physics: { default: "arcade", arcade: { gravity: { y: 0 }, debug: false } },
  scene: [RunnerScene],
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
});