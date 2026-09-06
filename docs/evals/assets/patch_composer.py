import re

html_path = 'docs/evals/20260905-lil-pix-composer.html'
with open(html_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace sim-actions in Column 1
actions_col1 = '''    <div class="sim-actions">
      <button class="btn-sim-action" onclick="petMascot(1)"><span>👋</span> 白手套揉头 (笑眼 ^^)</button>
      <button class="btn-sim-action" onclick="triggerLean(1)"><span>🛋️</span> 手肘搭在左边框 (打字陪伴)</button>
      <button class="btn-sim-action" onclick="goToSteps(1)"><span>🪜</span> 爬到执行步骤卡 (监控状态)</button>
      <button class="btn-sim-action" onclick="goToBubble(1)"><span>💬</span> 爬到用户气泡顶</button>
      <button class="btn-sim-action" onclick="resetToComposer(1)"><span>🏠</span> 优雅归位</button>
    </div>'''

actions_col2 = '''    <div class="sim-actions">
      <button class="btn-sim-action" onclick="petMascot(2)"><span>👋</span> 白手套揉头</button>
      <button class="btn-sim-action" onclick="triggerLean(2)"><span>🛋️</span> 手肘搭在左边框</button>
      <button class="btn-sim-action" onclick="goToSteps(2)"><span>🪜</span> 爬到步骤卡</button>
      <button class="btn-sim-action" onclick="goToBubble(2)"><span>💬</span> 爬到气泡顶</button>
      <button class="btn-sim-action" onclick="resetToComposer(2)"><span>🏠</span> 优雅归位</button>
    </div>'''

# Replace Column 1 actions
content = re.sub(r'<div class="sim-actions">\s*<button class="btn-sim-action" onclick="petMascot\(1\)">.*?</button>\s*<button class="btn-sim-action" onclick="resetToComposer\(1\)"><span>🏠</span> 优雅归位</button>\s*</div>', actions_col1, content, flags=re.DOTALL)

# Replace Column 2 actions
content = re.sub(r'<div class="sim-actions">\s*<button class="btn-sim-action" onclick="petMascot\(2\)">.*?</button>\s*<button class="btn-sim-action" onclick="walkAroundPerimeter\(2\)"><span>🏃</span> 边框外沿巡逻</button>\s*</div>', actions_col2, content, flags=re.DOTALL)

# Add helper functions goToSteps, goToBubble, simulateExecution in script
new_funcs = '''
  // Climb to user bubble top rim
  function goToBubble(id) {
    const actor = document.getElementById(`actor-${id}`);
    const sim = document.getElementById(`sim-${id}`);
    const msgs = document.getElementById(`msgs-${id}`);
    if (!actor || !sim || !msgs) return;

    const userBubbles = msgs.querySelectorAll('.msg-user');
    const target = userBubbles[userBubbles.length - 1];
    if (!target) return;

    const uRel = getRelativePos(target, sim);
    actor.classList.add('walking');
    setPose(id, 'walk');
    actor.style.transition = 'all 0.5s var(--ease-spring)';
    actor.style.top = (uRel.top - 28) + 'px';
    actor.style.left = (uRel.right - 44) + 'px';

    setTimeout(() => {
      actor.classList.remove('walking');
      setPose(id, 'lean');
      spawnLove(actor, '💬');
    }, 520);
  }

  // Climb to execution steps card
  function goToSteps(id) {
    const actor = document.getElementById(`actor-${id}`);
    const sim = document.getElementById(`sim-${id}`);
    const steps = document.getElementById(`c${id}-steps`);
    if (!actor || !sim || !steps) return;

    const sRel = getRelativePos(steps, sim);
    actor.classList.add('walking');
    setPose(id, 'walk');
    actor.style.transition = 'all 0.45s var(--ease-spring)';
    actor.style.top = (sRel.top - 28) + 'px';
    actor.style.left = (sRel.left + 22) + 'px';

    setTimeout(() => {
      actor.classList.remove('walking');
      setPose(id, 'lean');
      spawnLove(actor, '⚡');
    }, 480);
  }

  // Send message simulation: types -> sends -> companion watches steps -> celebrates
  function sendMessage(id) {
    const input = document.getElementById(`input-${id}`);
    const text = input ? input.value.trim() : '';
    if (input) input.value = '';

    const actor = document.getElementById(`actor-${id}`);
    goToSteps(id);

    // Simulate task completion in 1.8s
    setTimeout(() => {
      setPose(id, 'happy');
      spawnLove(actor, '🎉');
      setTimeout(() => {
        resetToComposer(id);
      }, 1200);
    }, 1800);
  }
'''

# Insert new_funcs right before window.addEventListener('DOMContentLoaded'
content = content.replace("function sendMessage(id) {", new_funcs + "\n  function _oldSendMessage(id) {")

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Patch applied successfully!")
