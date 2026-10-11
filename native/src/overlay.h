#ifndef AEGIS_OVERLAY_H
#define AEGIS_OVERLAY_H

#include <stddef.h>

/*
 * Mounts the cell's /workspace: overlayfs when possible, a bounded copy otherwise. Called by
 * boot.c's child, after pivot_root, with /workspace-lower, /workspace-rw (a host directory holding
 * "upper" and "work" subdirectories, bound as one mount so overlayfs sees them on the same
 * filesystem, which it requires) and /workspace (a second bind of workspace-rw's "upper"
 * subdirectory) already set up from host-visible directories, so whatever lands there is readable
 * by the host once the cell exits, even though the mount namespace itself vanishes with it.
 *
 * force_copy skips the overlay attempt outright (used by the test suite to exercise the fallback
 * deterministically, rather than relying on a kernel that happens to refuse the mount).
 *
 * Writes 1 or 0 into *used_overlay on success (0 meaning the copy fallback ran instead), and when
 * it is 0, the overlay mount's own errno into *overlay_errno (0 if it was never attempted because
 * force_copy was set) so the caller can report why, even though falling back is not fatal. On any
 * failure (the fallback copy itself failed) returns a negative errno and writes nothing to either
 * output parameter; the caller decides whether that is fatal.
 */
int aegis_overlay_mount(int force_copy, int *used_overlay, int *overlay_errno);

/*
 * Recursively copies every entry under src into dst, which must already exist and be empty.
 * Deliberately the one place in the boot path that uses opendir/readdir (and therefore glibc's
 * allocator): the "no malloc after clone3" rule targets the narrow, security-critical window
 * before namespaces and the private root exist, documented at this function's call site in
 * boot.c and in the stage report. Returns 0 or a negative errno.
 */
int aegis_overlay_copy_tree(const char *src, const char *dst);

#endif
