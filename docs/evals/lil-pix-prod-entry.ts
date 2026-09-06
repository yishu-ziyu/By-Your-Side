import { mountCompanion } from "../../extension/src/sidepanel/companion.js";

const app = document.getElementById("app")!;
const composer = document.getElementById("composer") as HTMLElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const messages = document.getElementById("messages") as HTMLElement;
const pill = document.getElementById("page-pill");

const companion = mountCompanion({
  appEl: app,
  composerEl: composer,
  inputEl: input,
  messagesEl: messages,
  pagePillEl: pill,
  spriteBase: "../../extension/assets/companion/",
});

document.getElementById("btn-type")!.onclick = () => {
  input.focus();
  companion.onTyping();
};
document.getElementById("btn-send")!.onclick = () => {
  companion.onSend(messages.querySelector(".msg.user"));
};
document.getElementById("btn-step")!.onclick = () => {
  companion.onStepStart(messages.querySelector("details.run-steps"));
};
document.getElementById("btn-done")!.onclick = () => companion.onStepDone();
document.getElementById("btn-finish")!.onclick = () => companion.onRunFinish();
document.getElementById("btn-home")!.onclick = () => companion.resetToComposer();
document.getElementById("btn-pet")!.onclick = () => {
  companion.spawnLove("♥");
  const host = document.getElementById("pix-companion")!;
  host.classList.add("pressing");
  setTimeout(() => {
    host.classList.remove("pressing");
    host.classList.add("rebounding");
    setTimeout(() => host.classList.remove("rebounding"), 480);
  }, 280);
};
