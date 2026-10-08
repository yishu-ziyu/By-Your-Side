import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GlassButton, GlassContent, GlassScene, GlassSurface } from '@glass-sdk/liquid-glass';
import { Popover } from '@base-ui/react/popover';
import '@glass-sdk/liquid-glass/styles.css';
import './styles.css';

const recipient = 'maya@studioworks.design';

function Icon({ type, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (type === 'spark') return <svg {...common}><path d="M12 2 14.8 9.2 22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8L12 2Z"/><path d="m19 2 .7 1.3L21 4l-1.3.7L19 6l-.7-1.3L17 4l1.3-.7L19 2Z"/></svg>;
  if (type === 'mail') return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>;
  if (type === 'check') return <svg {...common}><path d="m5 12 4.5 4.5L19 7"/></svg>;
  if (type === 'close') return <svg {...common}><path d="M6 6 18 18M18 6 6 18"/></svg>;
  if (type === 'arrow') return <svg {...common}><path d="M4 12h16M13 5l7 7-7 7"/></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>;
}

function BackgroundWorkspace({ state }) {
  return (
    <div className="browser-window" aria-label="模拟邮件工作区">
      <div className="browser-topbar">
        <div className="traffic-lights"><i/><i/><i/></div>
        <div className="address-label">workspaces / studio / drafts</div>
        <div className="topbar-tools"><span>◫</span><span>···</span></div>
      </div>
      <div className="app-layout">
        <aside className="app-sidebar">
          <div className="sidebar-brand"><span className="brand-icon">b.</span><span>by your side<span className="brand-period">.</span></span></div>
          <p className="sidebar-kicker">YOUR SPACE</p>
          <div className="nav-item"><span className="nav-dot"/> 概览</div>
          <div className="nav-item selected"><Icon type="mail" size={16}/> 收件箱 <span className="nav-count">3</span></div>
          <div className="nav-item"><span className="nav-dot muted"/> 草稿</div>
          <div className="nav-item"><span className="nav-dot muted"/> 已完成</div>
          <div className="sidebar-spacer"/>
          <div className="sidebar-bottom"><span className="avatar">Y</span><span><strong>Your agent</strong><small>Online · ready</small></span><span className="sidebar-tick"/></div>
        </aside>
        <main className="mail-workspace">
          <div className="workspace-breadcrumb">工作台 <span>/</span> 邮件任务 <span>/</span> <b>草稿 #041</b></div>
          <div className="workspace-heading">
            <div><div className="eyebrow">THURSDAY, OCTOBER 8</div><h2>Small things, handled.</h2><p>你专注重要的事，其余交给 Agent。</p></div>
            <div className="mini-account">SY <span className="mini-account-dot"/></div>
          </div>
          <div className="workspace-cards">
            <article className="draft-card">
              <div className="draft-head"><span className="tag-mail"><Icon type="mail" size={13}/> DRAFT</span><span className="card-dots">•••</span></div>
              <h3>Weekly design update</h3>
              <p className="draft-description">已整理本周产品交互调整，准备发送给 Maya。</p>
              <div className="letter-preview">
                <div className="letter-line"><span>To</span><strong>Maya Chen</strong></div>
                <div className="letter-line"><span>Subject</span><strong>Week 41 · Design progress</strong></div>
                <div className="letter-divider"/>
                <p>Hi Maya,</p>
                <p>Here’s a quick look at what we shaped this week, and what’s coming next...</p>
                <div className="letter-line-letter"/>
                <div className="letter-line-letter short"/>
              </div>
              <div className={'draft-status ' + (state === 'sent' ? 'is-sent' : '')} data-testid="draft-state">
                <span className="draft-status-dot"/>
                {state === 'sent' ? '模拟已发送' : '草稿待发送'}
              </div>
            </article>
            <div className="art-card" aria-hidden="true">
              <div className="art-cloud cloud-one"/><div className="art-cloud cloud-two"/>
              <div className="art-sun"/><div className="art-hill hill-back"/><div className="art-hill hill-front"/>
              <div className="art-horizon"/>
              <div className="art-title">FIELD NOTES <em>№</em> 41</div>
              <div className="art-subtitle">Quiet progress, visible impact.</div>
            </div>
          </div>
          <div className="mail-bottom"> <span className="soft-pulse"/> 任务正在本地模拟运行 <span className="bottom-linen">All changes stay in this preview.</span></div>
        </main>
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState('idle');
  const [refraction, setRefraction] = useState(55);
  const [diagnostic, setDiagnostic] = useState('未检测');
  const sceneRef = useRef(null);
  const triggerRef = useRef(null);
  const expanded = state === 'pending';
  const result = state === 'idle' ? 'Agent 正在工作' : state === 'pending' ? '等待你的决定' : state === 'cancelled' ? '已取消 · 草稿保留' : '模拟已发送 · 无网络请求';

  return (
    <div className="page-shell">
      <header className="page-header">
        <div className="top-line"><span className="tiny-glyph"><Icon type="spark" size={13}/></span> BY YOUR SIDE <span className="top-divider"/> INTERACTION STUDY 01</div>
        <div className="page-heading-row"><div><h1>Only when it matters<span>.</span></h1><p>Agent 默认安静。真正需要你决定时，玻璃才会浮现。</p></div><span className="preview-label">LOCAL PROTOTYPE <span>•</span> NO REAL SEND</span></div>
      </header>

      <section className="scene-shell" aria-label="交互演示">
        <GlassScene ref={sceneRef} material="regular" appearance="light" onDiagnostic={(message) => {
          const str = String(typeof message === 'string' ? message : JSON.stringify(message));
          if (str.includes('error') || str.includes('unavailable')) setDiagnostic('GPU 不可用，视觉降级');
          else if (str.includes('ready') || str.includes('map')) setDiagnostic('玻璃渲染已初始化');
          }} className="glass-scene">
          <GlassContent><BackgroundWorkspace state={state}/></GlassContent>
          <Popover.Root open={expanded} onOpenChange={(open) => {
            setState(current => open ? 'pending' : current === 'sent' ? 'sent' : 'cancelled');
          }}>
            <div className="agent-anchor">
              <Popover.Trigger
                ref={triggerRef}
                disabled={state === 'sent'}
                aria-label="打开确认面板"
                render={<GlassButton radius="capsule" material="regular" refraction={refraction} className="agent-pill" data-testid="agent-pill" />}
              >
                <span className="capsule-symbol"><Icon type={state === 'sent' ? 'check' : 'spark'} size={17}/></span>
                <span className="capsule-title">{state === 'sent' ? '已完成' : state === 'cancelled' ? '草稿已保留' : 'Agent 正在工作'}</span>
                <span className="capsule-pulse" aria-hidden="true"/>
              </Popover.Trigger>
            </div>
            <Popover.Portal container={sceneRef}>
              <Popover.Positioner side="bottom" align="end" sideOffset={12} className="agent-positioner">
                <GlassSurface
                  render={<Popover.Popup aria-label="发送前确认" />}
                  className="agent-glass-popup"
                  data-testid="glass-popup"
                  morphFrom={triggerRef}
                  morph="become"
                  neck={0}
                  material="regular"
                  refraction={refraction}
                  radius={31}
                >
                  <div className="confirmation-view">
                    <div className="confirmation-head">
                      <div className="asking-mark"><Icon type="spark" size={17}/></div>
                      <Popover.Close className="glass-dismiss" aria-label="关闭确认"><Icon type="close" size={17}/></Popover.Close>
                    </div>
                    <div className="confirmation-kicker"><span className="attention-dot"/> WAITING FOR YOU</div>
                    <h3>要发送这封邮件吗？</h3>
                    <p className="confirmation-copy">内容已经准备好。发送前需要你最后确认。</p>
                    <div className="mail-details">
                      <span className="detail-icon"><Icon type="mail" size={19}/></span>
                      <div className="detail-main"><strong>Maya Chen</strong><span>{recipient}</span></div>
                      <span className="detail-next"><Icon type="arrow" size={16}/></span>
                    </div>
                    <div className="confirm-actions">
                      <button type="button" className="action-cancel" onClick={() => setState('cancelled')}>取消发送</button>
                      <button type="button" className="action-send" onClick={() => setState('sent')}><Icon type="check" size={16}/> 确认发送</button>
                    </div>
                    <p className="demo-warning">仅模拟状态变化，不会连接邮箱或发送邮件。</p>
                  </div>
                </GlassSurface>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </GlassScene>
      </section>
      <section className="studio-controls" aria-label="演示控制">
        <div className="control-row">
          <div className="run-actions">
            <button type="button" className="control-primary" disabled={expanded || state === 'sent'} onClick={() => setState('pending')}>模拟需要确认 <span>↗</span></button>
            <button type="button" className="control-reset" onClick={() => setState('idle')}>重新开始</button>
          </div>
          <div className="result-status"><span className={'result-light ' + state}/><span data-testid="result-state" role="status">{result}</span></div>
        </div>
        <div className="tuning-row">
          <label className="tune-control"><span>玻璃折射 <strong>{refraction}</strong></span><input type="range" min="0" max="100" step="5" value={refraction} onChange={(e) => setRefraction(Number(e.target.value))} aria-label="玻璃折射强度"/></label>
          <div className="motion-readout"><strong>Native morph</strong><span>物理弹簧 · 内容随轮廓渐显 · 关闭沿原路收回</span></div>
          <div className="render-info"><span className="render-dot"/> WebGPU + SVG · {diagnostic}</div>
        </div>
      </section>
      <footer className="page-footer"><span>01 / Capsule</span><span>→</span><span>02 / Morph</span><span>→</span><span>03 / Decision</span><span>→</span><span>04 / Return</span><span className="footer-last">PROTOTYPE / EXPERIMENTAL</span></footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
