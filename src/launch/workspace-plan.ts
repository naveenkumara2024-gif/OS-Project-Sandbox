import type { LaunchSpec } from '../sys/launch-spec.js';

// Produces the workspace portion of the launch spec from host-visible directories the control
// plane already created (docs/prompts/stage-3-workspace.md section 4.5, Amendment-style fix after
// a measured overlayfs constraint: upperdir and workdir must be on the same mount, so `rw` is a
// single host directory holding "upper" and "work" subdirectories, bound once).

export interface WorkspaceDirs {
  readonly lower: string;
  /** Host directory already containing "upper" and "work" subdirectories. */
  readonly rw: string;
}

export function planWorkspace(
  dirs: WorkspaceDirs,
  forceCopy: boolean,
): NonNullable<LaunchSpec['workspace']> {
  return { lower: dirs.lower, rw: dirs.rw, forceCopy };
}
