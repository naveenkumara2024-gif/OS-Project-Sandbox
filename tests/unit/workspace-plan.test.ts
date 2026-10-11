import { describe, expect, it } from 'vitest';
import { planWorkspace } from '../../src/launch/workspace-plan.js';

describe('planWorkspace', () => {
  it('shapes the directories into a launch-spec workspace record', () => {
    const w = planWorkspace({ lower: '/a/lower', rw: '/a/rw' }, false);
    expect(w).toEqual({ lower: '/a/lower', rw: '/a/rw', forceCopy: false });
  });

  it('carries forceCopy through unchanged', () => {
    expect(planWorkspace({ lower: '/a', rw: '/b' }, true).forceCopy).toBe(true);
  });
});
