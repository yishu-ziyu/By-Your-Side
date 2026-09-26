import {describe,expect,it} from 'vitest';
import {BROWSER_DECISION_CONFIDENCE_THRESHOLD,goalConcernsBrowserTabs} from '../src/browser-action-selection.js';
import {ACT_THRESHOLD,GOAL_DONE_THRESHOLD,actionableControls,describeControl,sectionName} from '../src/browser-questions.js';
import type {BrowserObservation} from '../../shared/browser-decision.js';

function page(controls: BrowserObservation['controls'], extra: Partial<BrowserObservation> = {}): BrowserObservation {
  return {id: 'obs-1', tabId: 7, documentId: 'd1', url: 'https://form.test/', observedAt: Date.now(), source: 'accessibility', text: 'form', truncated: false, controls, ...extra};
}

describe('thresholds', () => {
  it('keeps the 0.85 action and completion thresholds', () => {
    expect(BROWSER_DECISION_CONFIDENCE_THRESHOLD).toBe(0.85);
    expect(ACT_THRESHOLD).toBe(0.85);
    expect(GOAL_DONE_THRESHOLD).toBe(0.85);
  });
});

describe('what Jev reads about controls', () => {
  // Failure modes: wrapper roles ("generic", "none") read as section names; disabled, protected or
  // dropdown-owned options become targets; a text field's current value is hidden.
  it('names sections only when they have a name', () => {
    expect(sectionName('generic')).toBeUndefined();
    expect(sectionName('none')).toBeUndefined();
    expect(sectionName('listitem')).toBeUndefined();
    expect(sectionName('generic Account')).toBe('"Account"');
    expect(sectionName('region Late')).toBe('region "Late"');
    expect(describeControl({ref: '@1', role: 'button', name: 'Go', disabled: false, scopeLabel: 'none'})).toBe('button "Go"');
    expect(describeControl({ref: '@2', role: 'textbox', name: 'Name', disabled: false, value: 'Ada', scopeLabel: 'form Profile'})).toBe('textbox "Name" in form "Profile" (value "Ada")');
    expect(describeControl({ref: '@3', role: 'checkbox', name: 'SMS', disabled: false, checked: false})).toBe('checkbox "SMS" (not checked)');
  });

  it('offers only enabled, unprotected controls that are not options owned by a dropdown', () => {
    const controls = actionableControls(page([
      {ref: '@1', role: 'button', name: 'Off', disabled: true},
      {ref: '@2', role: 'textbox', name: 'Password', disabled: false, protected: true},
      {ref: '@3', role: 'combobox', name: 'Country', disabled: false, options: [{ref: '@4', label: 'Japan', disabled: false}]},
      {ref: '@4', role: 'option', name: 'Japan', disabled: false},
      {ref: '@5', role: 'textbox', name: 'Notes', disabled: false, readOnly: true},
      {ref: '@6', role: 'link', name: 'Docs', disabled: false},
    ]));

    expect(controls.map(c => c.ref)).toEqual(['@3', '@6']);
  });
});

describe('browser tabs follow the goal', () => {
  // Failure modes: unrelated tabs dilute an in-page choice; a goal that names a tab loses the switch;
  // "table"/"tablet" count as tab words; a host or title mention is ignored.
  const tabs = [
    { id: 7, title: 'Account settings', url: 'https://form.test/', active: true, windowId: 1, working: true },
    { id: 9, title: 'Reference Docs', url: 'https://docs.example.org/guide', active: false, windowId: 1, working: false },
    { id: 11, title: 'about:blank', url: 'about:blank', active: false, windowId: 1, working: false },
  ];

  const obs = page([{ ref: '@1', role: 'menuitem', name: 'Settings', disabled: false }], { tabs });

  it('ignores tabs when the goal is about the current page', () => {
    expect(goalConcernsBrowserTabs('Open Account hover menu then click Settings', obs)).toBe(false);
    expect(goalConcernsBrowserTabs('Sort the table by date\nclick the tablet filter', obs)).toBe(false);
  });

  it('asks about tabs when the goal refers to tabs or names one', () => {
    expect(goalConcernsBrowserTabs('Switch to the Reference Docs tab', obs)).toBe(true);
    expect(goalConcernsBrowserTabs('切到另一个标签页', obs)).toBe(true);
    expect(goalConcernsBrowserTabs('go back to reference docs', obs)).toBe(true);
    expect(goalConcernsBrowserTabs('open the guide on docs.example.org', obs)).toBe(true);
  });
});
