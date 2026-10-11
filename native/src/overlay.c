#define _GNU_SOURCE
#include "overlay.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

enum { COPY_BUF_BYTES = 65536, PATH_CAP = 4096 };

static int copy_file(const char *src, const char *dst, mode_t mode)
{
    int in = open(src, O_RDONLY | O_CLOEXEC);
    if (in < 0) {
        return -errno;
    }
    int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, mode & 0777);
    if (out < 0) {
        int e = errno;
        close(in);
        return -e;
    }
    static unsigned char buf[COPY_BUF_BYTES];
    for (;;) {
        ssize_t r = read(in, buf, sizeof buf);
        if (r < 0) {
            int e = errno;
            close(in);
            close(out);
            return -e;
        }
        if (r == 0) {
            break;
        }
        ssize_t off = 0;
        while (off < r) {
            ssize_t w = write(out, buf + off, (size_t)(r - off));
            if (w < 0) {
                int e = errno;
                close(in);
                close(out);
                return -e;
            }
            off += w;
        }
    }
    close(in);
    close(out);
    return 0;
}

/* Depth is bounded by PATH_CAP, not by an explicit counter: join_path below fails closed with
 * ENAMETOOLONG long before any real workspace tree could exhaust it. */
static int join(char *out, size_t cap, const char *a, const char *b)
{
    size_t n = (size_t)snprintf(out, cap, "%s/%s", a, b);
    return n < cap ? 0 : -1;
}

int aegis_overlay_copy_tree(const char *src, const char *dst)
{
    /* opendir/readdir: see the rationale in overlay.h and the call site in boot.c. */
    DIR *d = opendir(src);
    if (d == NULL) {
        return -errno;
    }
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) {
            continue;
        }
        char sp[PATH_CAP], dp[PATH_CAP];
        if (join(sp, sizeof sp, src, e->d_name) != 0 || join(dp, sizeof dp, dst, e->d_name) != 0) {
            closedir(d);
            return -ENAMETOOLONG;
        }
        struct stat st;
        if (lstat(sp, &st) != 0) {
            closedir(d);
            return -errno;
        }
        int rc;
        if (S_ISDIR(st.st_mode)) {
            if (mkdir(dp, st.st_mode & 0777) != 0 && errno != EEXIST) {
                closedir(d);
                return -errno;
            }
            rc = aegis_overlay_copy_tree(sp, dp);
        } else if (S_ISREG(st.st_mode)) {
            rc = copy_file(sp, dp, st.st_mode);
        } else if (S_ISLNK(st.st_mode)) {
            char target[PATH_CAP];
            ssize_t n = readlink(sp, target, sizeof target - 1);
            if (n < 0) {
                rc = -errno;
            } else {
                target[n] = '\0';
                rc = symlink(target, dp) == 0 ? 0 : -errno;
            }
        } else {
            /* Device nodes, sockets and FIFOs from the host tree are never copied into a cell. */
            rc = 0;
        }
        if (rc != 0) {
            closedir(d);
            return rc;
        }
    }
    closedir(d);
    return 0;
}

int aegis_overlay_mount(int force_copy, int *used_overlay, int *overlay_errno)
{
    *overlay_errno = 0;
    if (!force_copy) {
        if (mount("overlay", "/workspace", "overlay", 0,
                  "lowerdir=/workspace-lower,upperdir=/workspace-rw/upper,"
                  "workdir=/workspace-rw/work,userxattr") == 0) {
            *used_overlay = 1;
            return 0;
        }
        *overlay_errno = errno;
    }
    /* Fallback: workspace-rw's "upper" subdirectory is already bind-mounted at /workspace
     * (boot.c), a host-visible directory. Populate it with the lower snapshot so the payload sees
     * a complete, writable tree, and the post-run diff compares this directory against
     * /workspace-lower on the host. */
    int rc = aegis_overlay_copy_tree("/workspace-lower", "/workspace");
    if (rc != 0) {
        return rc;
    }
    *used_overlay = 0;
    return 0;
}
