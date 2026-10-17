#define _GNU_SOURCE
#include "landlock.h"

#include "sys.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

/*
 * Landlock ruleset (prompt section 4.5). The ruleset comes from a fixed table in this file; the
 * control plane supplies no paths, so there is nothing to validate. The header must be new enough
 * to know ABI 6 (scopes); an older one fails the build rather than silently dropping a right.
 */

int aegis_landlock_abi(void)
{
    long v = aegis_sys_landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (v < 1) {
        if (v == 0) {
            errno = ENOSYS;
        }
        return -1;
    }
    return (int)v;
}

#define FS_READ (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)

static uint64_t fs_all(int abi)
{
    uint64_t a =
        LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
    if (abi >= 2) {
        a |= LANDLOCK_ACCESS_FS_REFER;
    }
    if (abi >= 3) {
        a |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }
    if (abi >= 5) {
        a |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    }
    return a;
}

/* Adds "everything in `rights` that this ABI handles" beneath `path`. A path that does not exist
 * (no workspace was requested) is skipped: a missing directory grants nothing. */
static int add_path(int ruleset, const char *path, uint64_t rights, uint64_t handled)
{
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        return errno == ENOENT ? 0 : -1;
    }
    struct landlock_path_beneath_attr pb;
    memset(&pb, 0, sizeof pb);
    pb.allowed_access = rights & handled;
    pb.parent_fd = fd;
    long r = aegis_sys_landlock_add_rule(ruleset, LANDLOCK_RULE_PATH_BENEATH, &pb, 0);
    int e = errno;
    close(fd);
    if (r != 0) {
        errno = e;
        return -1;
    }
    return 0;
}

int aegis_landlock_apply(aegis_landlock_info_t *info)
{
    memset(info, 0, sizeof *info);
    int abi = aegis_landlock_abi();
    if (abi < 0) {
        return -1;
    }
    info->abi = abi;

    uint64_t fs = fs_all(abi);
    struct landlock_ruleset_attr attr;
    memset(&attr, 0, sizeof attr);
    attr.handled_access_fs = fs;
    if (abi >= 4) {
        attr.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;
    }
    if (abi >= 6) {
        attr.scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL;
    }
    int rs = (int)aegis_sys_landlock_create_ruleset(&attr, sizeof attr, 0);
    if (rs < 0) {
        return -1;
    }
    int rc = 0;
    int saved = 0;
    do {
        /* Read and execute beneath the whole private root. */
        if (add_path(rs, "/", FS_READ | LANDLOCK_ACCESS_FS_EXECUTE, fs) != 0) {
            rc = -1;
            break;
        }
        /* Writable scratch and workspace. */
        static const char *const rw[] = {"/workspace", "/tmp", "/dev/shm"};
        for (size_t i = 0; i < sizeof rw / sizeof *rw; i++) {
            if (add_path(rs, rw[i], fs, fs) != 0) {
                rc = -1;
                break;
            }
        }
        if (rc != 0) {
            break;
        }
        /* The bound device nodes. */
        uint64_t dev = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE |
                       (abi >= 5 ? LANDLOCK_ACCESS_FS_IOCTL_DEV : 0ULL);
        if (add_path(rs, "/dev", dev, fs) != 0) {
            rc = -1;
            break;
        }
        if (aegis_sys_landlock_restrict_self(rs, 0) != 0) {
            rc = -1;
            break;
        }
    } while (0);
    if (rc != 0) {
        saved = errno;
    }
    close(rs);
    if (rc != 0) {
        errno = saved;
        return -1;
    }
    info->handled_fs = 1;
    info->handled_net = abi >= 4;
    info->handled_scope = abi >= 6;
    return 0;
}
