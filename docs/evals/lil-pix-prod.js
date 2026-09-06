// extension/src/sidepanel/companion.ts
var SPRITE_W = 34;
var RIM_GAP = 32;
var LEAN_GAP = 28;
var POSE_FILE = {
  idle: "pix_idle.png",
  point: "pix_point.png",
  lean: "pix_lean.png",
  happy: "pix_pet_happy.png",
  walk: "pix_walk.png"
};
function spriteUrl(file, base) {
  if (base) return `${base.replace(/\/?$/, "/")}${file}`;
  return typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(`companion/${file}`) : `companion/${file}`;
}
function reduceMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function toBox(r) {
  return { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height };
}
function composerIdleAnchor(composer2, app2, pill2) {
  const top = composer2.top - app2.top - RIM_GAP;
  let left = composer2.left - app2.left + 22;
  if (pill2) left = Math.max(left, pill2.right - app2.left + 6);
  const maxLeft = composer2.right - app2.left - SPRITE_W - 8;
  const minLeft = composer2.left - app2.left + 8;
  return { top, left: Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft)) };
}
function rimAnchor(target, app2, kind, bounds) {
  let top = target.top - app2.top - (kind === "lean" ? LEAN_GAP : RIM_GAP);
  let left;
  if (kind === "lean") left = target.left - app2.left + 8;
  else if (kind === "bubble") left = target.left - app2.left - 2;
  else left = target.left - app2.left + 10;
  if (bounds && top < bounds.minTop) {
    top = bounds.minTop;
    const leftSide = target.left - app2.left - SPRITE_W - 4;
    if (leftSide >= bounds.minLeft) left = leftSide;
  }
  if (bounds) {
    top = Math.max(top, bounds.minTop);
    left = Math.min(Math.max(left, bounds.minLeft), bounds.maxLeft);
  }
  return { top, left };
}
var SideCompanion = class {
  appEl;
  composerEl;
  inputEl;
  messagesEl;
  pagePillEl;
  spriteBase;
  hostEl;
  spriteImg;
  currentPose = "idle";
  isPressing = false;
  isVisiting = false;
  visitTarget = null;
  timers = /* @__PURE__ */ new Set();
  resizeObserver = null;
  onResize;
  onScroll;
  reduced;
  constructor(options) {
    this.appEl = options.appEl;
    this.composerEl = options.composerEl;
    this.inputEl = options.inputEl;
    this.messagesEl = options.messagesEl;
    this.pagePillEl = options.pagePillEl ?? null;
    this.spriteBase = options.spriteBase;
    this.reduced = reduceMotion();
    this.hostEl = document.createElement("div");
    this.hostEl.className = "pix-actor-host";
    this.hostEl.id = "pix-companion";
    this.hostEl.setAttribute("title", "\u6478\u6478\u6211");
    this.hostEl.setAttribute("aria-hidden", "true");
    this.spriteImg = document.createElement("img");
    this.spriteImg.className = "pix-sprite-img";
    this.spriteImg.alt = "";
    this.spriteImg.draggable = false;
    let firstFrame = true;
    this.spriteImg.addEventListener("load", () => {
      if (!firstFrame) return;
      firstFrame = false;
      if (!this.isVisiting) this.resetToComposer();
    });
    this.hostEl.appendChild(this.spriteImg);
    this.appEl.appendChild(this.hostEl);
    this.setPose("idle");
    this.bindGestures();
    this.bindInputListeners();
    this.onResize = () => {
      if (!this.isVisiting) this.resetToComposer();
      else this.placeOnVisitTarget();
    };
    this.onScroll = () => {
      if (this.isVisiting) this.placeOnVisitTarget();
    };
    window.addEventListener("resize", this.onResize);
    this.messagesEl.addEventListener("scroll", this.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.composerEl);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => this.resetToComposer()));
  }
  visitBounds() {
    const app2 = this.appOrigin();
    const topbar = this.appEl.querySelector("#topbar");
    const msg = this.boxOf(this.messagesEl);
    const minTop = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom - app2.top + 2) : Math.max(0, msg.top - app2.top);
    return {
      minTop,
      minLeft: 8,
      maxLeft: this.appEl.clientWidth - SPRITE_W - 8
    };
  }
  later(ms, fn) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }
  clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }
  appOrigin() {
    const r = this.appEl.getBoundingClientRect();
    return { top: r.top, left: r.left };
  }
  boxOf(el) {
    return toBox(el.getBoundingClientRect());
  }
  moveTo(pos, ms) {
    if (this.reduced) {
      this.hostEl.style.transition = "none";
    } else {
      this.hostEl.style.transition = `top ${ms}ms var(--spring-fluid), left ${ms}ms var(--spring-fluid)`;
    }
    this.hostEl.style.top = `${Math.round(pos.top)}px`;
    this.hostEl.style.left = `${Math.round(pos.left)}px`;
  }
  setPose(pose) {
    this.currentPose = pose;
    this.spriteImg.src = spriteUrl(POSE_FILE[pose], this.spriteBase);
  }
  resetToComposer() {
    this.isVisiting = false;
    this.visitTarget = null;
    this.hostEl.classList.remove("walking");
    const pos = composerIdleAnchor(
      this.boxOf(this.composerEl),
      this.appOrigin(),
      this.pagePillEl ? this.boxOf(this.pagePillEl) : null
    );
    this.moveTo(pos, 380);
    this.setPose("idle");
  }
  triggerLean() {
    if (this.isVisiting) return;
    const composer2 = this.boxOf(this.composerEl);
    const app2 = this.appOrigin();
    const pill2 = this.pagePillEl ? this.boxOf(this.pagePillEl) : null;
    const idle = composerIdleAnchor(composer2, app2, pill2);
    let lean = rimAnchor(composer2, app2, "lean");
    if (pill2 && lean.left + SPRITE_W > pill2.left - app2.left && lean.left < pill2.right - app2.left) {
      lean = idle;
    }
    if (!this.reduced) {
      this.hostEl.classList.add("walking");
      this.setPose("walk");
    }
    this.moveTo(lean, 320);
    this.later(this.reduced ? 0 : 340, () => {
      this.hostEl.classList.remove("walking");
      this.setPose("lean");
    });
  }
  bindGestures() {
    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.isPressing = true;
      this.hostEl.classList.add("pressing");
      this.spawnLove("\u2665");
      const onMouseUp = () => {
        if (!this.isPressing) return;
        this.isPressing = false;
        this.hostEl.classList.remove("pressing");
        if (!this.reduced) this.hostEl.classList.add("rebounding");
        this.spawnLove("\u2726");
        this.later(this.reduced ? 80 : 480, () => {
          this.hostEl.classList.remove("rebounding");
          if (document.activeElement === this.inputEl) this.setPose("lean");
          else this.setPose("idle");
        });
        window.removeEventListener("mouseup", onMouseUp);
      };
      window.addEventListener("mouseup", onMouseUp);
    };
    this.hostEl.addEventListener("mousedown", onMouseDown);
  }
  bindInputListeners() {
    this.inputEl.addEventListener("focus", () => {
      this.triggerLean();
    });
    this.inputEl.addEventListener("blur", () => {
      this.later(550, () => {
        if (!this.isVisiting && document.activeElement !== this.inputEl) {
          this.resetToComposer();
        }
      });
    });
    this.inputEl.addEventListener("input", () => this.onTyping());
  }
  spawnLove(char) {
    if (this.reduced) return;
    const p = document.createElement("div");
    p.className = "sparkle-pop";
    p.textContent = char;
    p.style.top = "-12px";
    p.style.left = `${Math.random() * 16 + 8}px`;
    this.hostEl.appendChild(p);
    this.later(700, () => p.remove());
  }
  onTyping() {
    if (this.currentPose !== "lean") this.triggerLean();
  }
  onSend(bubbleEl) {
    const bubble = bubbleEl ?? this.messagesEl.querySelector(".msg.user:last-of-type");
    if (!bubble) {
      this.triggerLean();
      return;
    }
    this.visit(bubble, "bubble", 8e3);
  }
  onStepStart(stepCardEl) {
    const card = stepCardEl ?? this.messagesEl.querySelector("details.run-steps:last-of-type");
    if (!card) return;
    this.visit(card, "step", 12e3);
  }
  onStepDone() {
    this.spriteImg.style.transform = "scale(1.12, 0.92)";
    this.later(120, () => {
      this.spriteImg.style.transform = "";
    });
  }
  onTakeover(isUserControl) {
    if (isUserControl) {
      this.setPose("point");
      this.spawnLove("!");
    } else {
      this.setPose("happy");
      this.spawnLove("\u2726");
    }
  }
  onRunFinish() {
    this.clearTimers();
    this.setPose("happy");
    if (!this.reduced) this.hostEl.classList.add("rebounding");
    this.spawnLove("\u2726");
    this.later(this.reduced ? 200 : 1200, () => {
      this.hostEl.classList.remove("rebounding");
      this.resetToComposer();
    });
  }
  visit(target, kind, holdMs) {
    this.clearTimers();
    this.isVisiting = true;
    this.visitTarget = target;
    if (!this.reduced) {
      this.hostEl.classList.add("walking");
      this.setPose("walk");
    }
    this.placeOnVisitTarget(kind);
    this.later(this.reduced ? 0 : 480, () => {
      this.hostEl.classList.remove("walking");
      this.setPose(kind === "bubble" ? "point" : "lean");
    });
    this.later(holdMs, () => {
      if (this.visitTarget === target) this.resetToComposer();
    });
  }
  placeOnVisitTarget(kind) {
    const target = this.visitTarget;
    if (!target || !this.appEl.contains(target)) {
      this.resetToComposer();
      return;
    }
    const msgRect = this.messagesEl.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const visible = tRect.bottom > msgRect.top + 8 && tRect.top < msgRect.bottom - 8;
    if (!visible) {
      this.resetToComposer();
      return;
    }
    const inferred = kind ?? (target.classList.contains("msg") ? "bubble" : "step");
    const pos = rimAnchor(this.boxOf(target), this.appOrigin(), inferred, this.visitBounds());
    this.moveTo(pos, 420);
  }
  destroy() {
    this.clearTimers();
    window.removeEventListener("resize", this.onResize);
    this.messagesEl.removeEventListener("scroll", this.onScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.hostEl.remove();
  }
};
function mountCompanion(options) {
  return new SideCompanion(options);
}

// docs/evals/lil-pix-prod-entry.ts
var app = document.getElementById("app");
var composer = document.getElementById("composer");
var input = document.getElementById("input");
var messages = document.getElementById("messages");
var pill = document.getElementById("page-pill");
var companion = mountCompanion({
  appEl: app,
  composerEl: composer,
  inputEl: input,
  messagesEl: messages,
  pagePillEl: pill,
  spriteBase: "../../extension/assets/companion/"
});
document.getElementById("btn-type").onclick = () => {
  input.focus();
  companion.onTyping();
};
document.getElementById("btn-send").onclick = () => {
  companion.onSend(messages.querySelector(".msg.user"));
};
document.getElementById("btn-step").onclick = () => {
  companion.onStepStart(messages.querySelector("details.run-steps"));
};
document.getElementById("btn-done").onclick = () => companion.onStepDone();
document.getElementById("btn-finish").onclick = () => companion.onRunFinish();
document.getElementById("btn-home").onclick = () => companion.resetToComposer();
document.getElementById("btn-pet").onclick = () => {
  companion.spawnLove("\u2665");
  const host = document.getElementById("pix-companion");
  host.classList.add("pressing");
  setTimeout(() => {
    host.classList.remove("pressing");
    host.classList.add("rebounding");
    setTimeout(() => host.classList.remove("rebounding"), 480);
  }, 280);
};
