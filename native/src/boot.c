#define _GNU_SOURCE
#include "boot.h"

#include "spec.h"
#include "sys.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * Boot sequence (docs/prompts/stage-1-core-cell.md section 4 and Amendment 1).
 *
 * The process is single-threaded. Everything that needs memory (the spec, the parsed view, the
 * mountinfo buffer, path buffers) is static, so nothing allocates after clone3 (CLAUDE.md 5.2).
 * Status lines go out with write(2) from fixed buffers.
 *
 * Fail closed: every `layer <name> ok` record is written only after the property it names has been
 * observed (namespace inode differs from the parent's, pid is 1, mounts verified read-only), and
 * any failure before exec aborts the cell with a `layer <name> fail <errno>` record.
 */

enum { FD_SPEC = 3, FD_STATUS = 4, FD_CONTROL = 5, FIRST_UNUSED_FD = 6 };
enum { EXIT_OK = 0, EXIT_NOT_ESTABLISHED = 1, EXIT_BAD_SPEC = 65, EXIT_INTERNAL = 70 };
enum { PATH_CAP = 8192, NS_COUNT = 8, NS_LINK_CAP = 64 };

static uint8_t g_spec_buf[AEGIS_SPEC_MAX_BYTES + 1U];
static aegis_spec_t g_spec;
static char g_mountinfo[512U * 1024U];
static char g_parent_ns[NS_COUNT][NS_LINK_CAP];
static int g_exec_pipe_w = -1;

/* /proc/self/ns entry and the layer it proves. Every namespace is compared with the parent's right
 * after proc is mounted; all are *reported* only once pivot_root has succeeded. */
static const struct {
    const char *link;
    const char *layer;
} k_ns[NS_COUNT] = {
    {"user", "userns"}, {"pid", "pidns"}, {"mnt", "mountns"},     {"net", "netns"},
    {"ipc", "ipcns"},   {"uts", "utsns"}, {"cgroup", "cgroupns"}, {"time", "timens"},
};

static const char *const k_devices[] = {"null", "zero", "full", "random", "urandom", "tty"};
enum { DEVICE_COUNT = 6 };

static void status_line(const char *s)
{
    size_t n = strlen(s);
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(FD_STATUS, s + off, n - off);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            return; /* the reader is gone; the control pipe will tell us to stop */
        }
        off += (size_t)w;
    }
}

static void status_layer(const char *layer, int ok_flag, int err_no)
{
    char line[96];
    int n;
    if (ok_flag) {
        n = snprintf(line, sizeof line, "layer %s ok\n", layer);
    } else {
        n = snprintf(line, sizeof line, "layer %s fail %d\n", layer, err_no);
    }
    if (n > 0 && (size_t)n < sizeof line) {
        status_line(line);
    }
}

static void status_num(const char *word, long v)
{
    char line[64];
    int n = snprintf(line, sizeof line, "%s %ld\n", word, v);
    if (n > 0 && (size_t)n < sizeof line) {
        status_line(line);
    }
}

/* Child-side failure: tell the host which layer failed, tell the parent through the exec pipe
 * that the failure is already reported, and exit without running any payload code. */
static void child_fail(const char *layer, int err_no)
{
    status_layer(layer, 0, err_no);
    if (g_exec_pipe_w >= 0) {
        char b = 'F';
        ssize_t w = write(g_exec_pipe_w, &b, 1);
        (void)w;
    }
    _exit(90);
}

static int join_path(char *out, size_t cap, const char *a, const char *b)
{
    size_t la = strlen(a);
    size_t lb = strlen(b);
    if (la + lb + 1U > cap) {
        errno = ENAMETOOLONG;
        return -1;
    }
    int n = snprintf(out, cap, "%s%s", a, b);
    return (n < 0 || (size_t)n >= cap) ? -1 : 0;
}

static int write_all_file(const char *path, const char *data)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0644);
    if (fd < 0) {
        return -1;
    }
    size_t n = strlen(data);
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, data + off, n - off);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            int e = errno;
            close(fd);
            errno = e;
            return -1;
        }
        off += (size_t)w;
    }
    return close(fd);
}

static int touch_file(const char *path)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0644);
    if (fd < 0) {
        return -1;
    }
    return close(fd);
}

static int read_link_into(const char *path, char *buf, size_t cap)
{
    ssize_t n = readlink(path, buf, cap - 1U);
    if (n < 0) {
        return -1;
    }
    buf[n] = '\0';
    return 0;
}

/* Reads the whole file into g_mountinfo; fails with E2BIG instead of truncating. */
static int slurp_mountinfo(const char *path)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return -1;
    }
    size_t len = 0;
    for (;;) {
        if (len == sizeof g_mountinfo - 1U) {
            close(fd);
            errno = E2BIG;
            return -1;
        }
        ssize_t r = read(fd, g_mountinfo + len, sizeof g_mountinfo - 1U - len);
        if (r < 0) {
            if (errno == EINTR) {
                continue;
            }
            int e = errno;
            close(fd);
            errno = e;
            return -1;
        }
        if (r == 0) {
            break;
        }
        len += (size_t)r;
    }
    close(fd);
    g_mountinfo[len] = '\0';
    return 0;
}

/* Decodes the \ooo octal escapes the kernel uses in mountinfo paths, in place. */
static void unescape_mount_field(char *s)
{
    char *w = s;
    for (const char *r = s; *r != '\0';) {
        if (r[0] == '\\' && r[1] >= '0' && r[1] <= '3' && r[2] >= '0' && r[2] <= '7' &&
            r[3] >= '0' && r[3] <= '7') {
            *w++ = (char)(((r[1] - '0') << 6) | ((r[2] - '0') << 3) | (r[3] - '0'));
            r += 4;
        } else {
            *w++ = *r++;
        }
    }
    *w = '\0';
}

static int is_planned_mount(const char *mp, const char planned[][PATH_CAP], size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if (strcmp(planned[i], mp) == 0) {
            return 1;
        }
    }
    return 0;
}

/*
 * Amendment 1: the plan is not trusted. Every mount that sits under <root>/usr must be one the
 * plan asked for; a host mount that appeared under /usr between planning and boot (or one the
 * recursive bind of a leaf directory dragged in) aborts the cell.
 */
static int verify_usr_mounts(const char *root, const char planned[][PATH_CAP], size_t nplanned)
{
    char proc_mi[PATH_CAP];
    char prefix[PATH_CAP];
    if (join_path(proc_mi, sizeof proc_mi, root, "/proc/self/mountinfo") != 0 ||
        join_path(prefix, sizeof prefix, root, "/usr") != 0) {
        errno = ENAMETOOLONG;
        return -1;
    }
    if (slurp_mountinfo(proc_mi) != 0) {
        return -1;
    }
    size_t plen = strlen(prefix);
    char *line = g_mountinfo;
    while (*line != '\0') {
        char *eol = strchr(line, '\n');
        if (eol != NULL) {
            *eol = '\0';
        }
        /* mountinfo: id parent maj:min root mountpoint ... ; mountpoint is the fifth field. */
        char *f = line;
        for (int i = 0; i < 4 && f != NULL; i++) {
            f = strchr(f, ' ');
            if (f != NULL) {
                f++;
            }
        }
        if (f != NULL) {
            char *end = strchr(f, ' ');
            if (end != NULL) {
                *end = '\0';
                unescape_mount_field(f);
                if (strncmp(f, prefix, plen) == 0 && (f[plen] == '\0' || f[plen] == '/')) {
                    if (!is_planned_mount(f, planned, nplanned)) {
                        errno = EPROTO;
                        return -1;
                    }
                }
            }
        }
        if (eol == NULL) {
            break;
        }
        line = eol + 1;
    }
    return 0;
}

/* Remounts a fresh bind read-only, nosuid, nodev, keeping the flags the kernel locked, and
 * verifies the result with statvfs. A read-only claim that is not checked is not a layer. */
static int harden_bind(const char *target)
{
    struct statvfs sv;
    if (statvfs(target, &sv) != 0) {
        return -1;
    }
    unsigned long keep =
        (unsigned long)sv.f_flag & (ST_NOEXEC | ST_NOATIME | ST_NODIRATIME | ST_RELATIME);
    if (mount(NULL, target, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | keep,
              NULL) != 0) {
        return -1;
    }
    if (statvfs(target, &sv) != 0) {
        return -1;
    }
    unsigned long want = ST_RDONLY | ST_NOSUID | ST_NODEV;
    if (((unsigned long)sv.f_flag & want) != want) {
        errno = EPROTO;
        return -1;
    }
    return 0;
}

static int build_synthetic_etc(const char *root)
{
    char p[PATH_CAP];
    if (join_path(p, sizeof p, root, "/etc/passwd") != 0 ||
        write_all_file(p, "root:x:0:0:root:/tmp:/usr/bin/sh\n") != 0) {
        return -1;
    }
    if (join_path(p, sizeof p, root, "/etc/group") != 0 || write_all_file(p, "root:x:0:\n") != 0) {
        return -1;
    }
    if (join_path(p, sizeof p, root, "/etc/hosts") != 0 ||
        write_all_file(p, "127.0.0.1 localhost\n") != 0) {
        return -1;
    }
    return 0;
}

static int bind_devices(const char *root)
{
    for (size_t i = 0; i < DEVICE_COUNT; i++) {
        char host[64];
        char tgt[PATH_CAP];
        char rel[64];
        if (snprintf(host, sizeof host, "/dev/%s", k_devices[i]) < 0 ||
            snprintf(rel, sizeof rel, "/dev/%s", k_devices[i]) < 0 ||
            join_path(tgt, sizeof tgt, root, rel) != 0) {
            errno = ENAMETOOLONG;
            return -1;
        }
        if (touch_file(tgt) != 0) {
            return -1;
        }
        /* A device node cannot be created in a user namespace, so the host's is bound. The mount
         * keeps the host's flags (it must stay usable as a device, so no nodev here). */
        if (mount(host, tgt, NULL, MS_BIND, NULL) != 0) {
            return -1;
        }
    }
    return 0;
}

/* Runs in the clone3 child as PID 1 of the new namespaces; never returns. */
static void child_main(int sync_fd)
{
    const aegis_spec_t *s = &g_spec;
    const char *root = s->root_mountpoint;
    char p[PATH_CAP];
    char opts[96];
    static char planned[AEGIS_SPEC_MAX_ENTRIES + AEGIS_SPEC_MAX_MASKS][PATH_CAP];
    size_t nplanned = 0;

    /* If the helper dies, the cell dies with it (the kernel sends this when the parent exits). */
    prctl(PR_SET_PDEATHSIG, SIGKILL);
    (void)signal(SIGPIPE, SIG_DFL);

    char go = 0;
    ssize_t r;
    do {
        r = read(sync_fd, &go, 1);
    } while (r < 0 && errno == EINTR);
    if (r != 1 || go != 'G') {
        _exit(91); /* parent could not write the id maps and has reported it */
    }

    /* 1. Stop mount propagation to the host before touching anything. */
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
        child_fail("mountns", errno);
    }

    /* 2. Root: a size-capped tmpfs on the host-owned directory. Options come from an integer. */
    if (snprintf(opts, sizeof opts, "size=%llu,mode=0755",
                 (unsigned long long)s->root_tmpfs_bytes) < 0) {
        child_fail("root", EINVAL);
    }
    if (mount("tmpfs", root, "tmpfs", MS_NOSUID | MS_NODEV, opts) != 0) {
        child_fail("root", errno);
    }
    static const char *const top_dirs[] = {"/usr", "/proc", "/dev", "/tmp", "/etc", "/.old"};
    for (size_t i = 0; i < sizeof top_dirs / sizeof *top_dirs; i++) {
        if (join_path(p, sizeof p, root, top_dirs[i]) != 0 || mkdir(p, 0755) != 0) {
            child_fail("root", errno);
        }
    }
    static const struct {
        const char *link;
        const char *target;
    } top_links[] = {
        {"/bin", "usr/bin"}, {"/lib", "usr/lib"}, {"/lib64", "usr/lib64"}, {"/sbin", "usr/sbin"}};
    for (size_t i = 0; i < sizeof top_links / sizeof *top_links; i++) {
        if (join_path(p, sizeof p, root, top_links[i].link) != 0 ||
            symlink(top_links[i].target, p) != 0) {
            child_fail("root", errno);
        }
    }

    /* 3. Fresh procfs, mounted by PID 1 of the new pid namespace before anything is stacked over
     * the host's /proc (the kernel refuses a procfs mount that would reveal less than it hides). */
    if (join_path(p, sizeof p, root, "/proc") != 0 ||
        mount("proc", p, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) {
        child_fail("proc", errno);
    }

    /* 4. Namespaces: observed, not assumed. */
    for (size_t i = 0; i < NS_COUNT; i++) {
        char link[PATH_CAP];
        char now[NS_LINK_CAP];
        if (snprintf(link, sizeof link, "%s/proc/self/ns/%s", root, k_ns[i].link) < 0 ||
            read_link_into(link, now, sizeof now) != 0) {
            child_fail(k_ns[i].layer, errno);
        }
        if (g_parent_ns[i][0] == '\0' || strcmp(now, g_parent_ns[i]) == 0) {
            child_fail(k_ns[i].layer, EPERM);
        }
    }
    if (getpid() != 1) {
        child_fail("pidns", EPERM);
    }

    /* 5. The planned /usr tree: binds, then read-only hardening of each, then verification. */
    for (size_t i = 0; i < s->nentries; i++) {
        const aegis_root_entry_t *e = &s->entries[i];
        if (join_path(p, sizeof p, root, e->tgt) != 0) {
            child_fail("root", ENAMETOOLONG);
        }
        switch (e->kind) {
        case AEGIS_ENTRY_MKDIR:
            if (mkdir(p, 0755) != 0 && errno != EEXIST) {
                child_fail("root", errno);
            }
            break;
        case AEGIS_ENTRY_SYMLINK:
            if (symlink(e->src, p) != 0) {
                child_fail("root", errno);
            }
            break;
        case AEGIS_ENTRY_BIND_DIR:
            if (mkdir(p, 0755) != 0 && errno != EEXIST) {
                child_fail("root", errno);
            }
            if (mount(e->src, p, NULL, MS_BIND | MS_REC, NULL) != 0) {
                child_fail("root", errno);
            }
            memcpy(planned[nplanned++], p, strlen(p) + 1U);
            break;
        case AEGIS_ENTRY_BIND_FILE:
            if (touch_file(p) != 0) {
                child_fail("root", errno);
            }
            if (mount(e->src, p, NULL, MS_BIND, NULL) != 0) {
                child_fail("root", errno);
            }
            memcpy(planned[nplanned++], p, strlen(p) + 1U);
            break;
        default:
            child_fail("root", EINVAL);
        }
    }
    for (size_t i = 0; i < nplanned; i++) {
        if (harden_bind(planned[i]) != 0) {
            child_fail("root", errno);
        }
    }

    /* 6. Mask files and directories that must not be offered inside the cell (Node.js). Empty
     * sources are made on the tmpfs root and unlinked after pivot_root; the mounts keep them. */
    char empty_file[PATH_CAP];
    char empty_dir[PATH_CAP];
    if (join_path(empty_file, sizeof empty_file, root, "/.empty-file") != 0 ||
        join_path(empty_dir, sizeof empty_dir, root, "/.empty-dir") != 0 ||
        touch_file(empty_file) != 0 || mkdir(empty_dir, 0755) != 0) {
        child_fail("root", errno);
    }
    for (size_t pass = 0; pass < 2; pass++) {
        size_t n = pass == 0 ? s->nmask_files : s->nmask_dirs;
        for (size_t i = 0; i < n; i++) {
            const char *rel = pass == 0 ? s->mask_files[i] : s->mask_dirs[i];
            struct stat st;
            if (join_path(p, sizeof p, root, rel) != 0) {
                child_fail("root", ENAMETOOLONG);
            }
            if (lstat(p, &st) != 0) {
                continue; /* nothing there to hide */
            }
            if ((pass == 0 && !S_ISREG(st.st_mode)) || (pass == 1 && !S_ISDIR(st.st_mode))) {
                continue;
            }
            if (nplanned >= sizeof planned / sizeof *planned) {
                child_fail("root", E2BIG);
            }
            if (mount(pass == 0 ? empty_file : empty_dir, p, NULL, MS_BIND, NULL) != 0) {
                child_fail("root", errno);
            }
            memcpy(planned[nplanned++], p, strlen(p) + 1U);
            if (harden_bind(p) != 0) {
                child_fail("root", errno);
            }
        }
    }
    if (verify_usr_mounts(root, (const char (*)[PATH_CAP])planned, nplanned) != 0) {
        child_fail("root", errno);
    }

    /* 7. /dev, /dev/shm, /tmp, /etc. */
    if (join_path(p, sizeof p, root, "/dev") != 0 ||
        mount("tmpfs", p, "tmpfs", MS_NOSUID, "size=65536,mode=0755") != 0) {
        child_fail("dev", errno);
    }
    if (bind_devices(root) != 0) {
        child_fail("dev", errno);
    }
    if (join_path(p, sizeof p, root, "/dev/shm") != 0 || mkdir(p, 01777) != 0 ||
        chmod(p, 01777) != 0 ||
        mount("tmpfs", p, "tmpfs", MS_NOSUID | MS_NODEV, "size=1048576") != 0) {
        child_fail("dev", errno);
    }
    static const struct {
        const char *link;
        const char *target;
    } dev_links[] = {{"/dev/fd", "/proc/self/fd"},
                     {"/dev/stdin", "/proc/self/fd/0"},
                     {"/dev/stdout", "/proc/self/fd/1"},
                     {"/dev/stderr", "/proc/self/fd/2"}};
    for (size_t i = 0; i < sizeof dev_links / sizeof *dev_links; i++) {
        if (join_path(p, sizeof p, root, dev_links[i].link) != 0 ||
            symlink(dev_links[i].target, p) != 0) {
            child_fail("dev", errno);
        }
    }
    if (snprintf(opts, sizeof opts, "size=%llu,mode=1777", (unsigned long long)s->tmp_tmpfs_bytes) <
            0 ||
        join_path(p, sizeof p, root, "/tmp") != 0 ||
        mount("tmpfs", p, "tmpfs", MS_NOSUID | MS_NODEV, opts) != 0) {
        child_fail("root", errno);
    }
    if (chmod(p, 01777) != 0 || build_synthetic_etc(root) != 0) {
        child_fail("root", errno);
    }

    /* 8. Enter the new root and drop the host's tree. */
    if (chdir(root) != 0) {
        child_fail("mountns", errno);
    }
    if (aegis_sys_pivot_root(".", ".old") != 0) {
        child_fail("mountns", errno);
    }
    if (chdir("/") != 0 || umount2("/.old", MNT_DETACH) != 0 || rmdir("/.old") != 0) {
        child_fail("mountns", errno);
    }
    unlink("/.empty-file");
    rmdir("/.empty-dir");
    if (sethostname(s->hostname, strlen(s->hostname)) != 0) {
        child_fail("utsns", errno);
    }
    umask(022);

    for (size_t i = 0; i < NS_COUNT; i++) {
        status_layer(k_ns[i].layer, 1, 0);
    }
    status_layer("root", 1, 0);
    status_layer("proc", 1, 0);
    status_layer("dev", 1, 0);

    /* execve with the spec's argv and an explicit environment; nothing is inherited. The status,
     * spec and control descriptors are close-on-exec, so the payload never sees them. */
    execve(s->argv[0], (char *const *)(uintptr_t)s->argv, (char *const *)(uintptr_t)s->envp);
    child_fail("exec", errno);
}

static int write_map_file(long pid, const char *name, const char *data)
{
    char path[64];
    if (snprintf(path, sizeof path, "/proc/%ld/%s", pid, name) < 0) {
        return -1;
    }
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) {
        return -1;
    }
    size_t n = strlen(data);
    ssize_t w;
    do {
        w = write(fd, data, n);
    } while (w < 0 && errno == EINTR);
    int e = errno;
    close(fd);
    if (w < 0 || (size_t)w != n) {
        errno = (w < 0) ? e : EIO;
        return -1;
    }
    return 0;
}

/* setgroups must be denied before an unprivileged gid_map write is accepted (user_namespaces(7)).
 */
static int write_id_maps(long pid, unsigned int uid, unsigned int gid)
{
    char map[48];
    if (write_map_file(pid, "setgroups", "deny") != 0) {
        return errno;
    }
    if (snprintf(map, sizeof map, "0 %u 1\n", gid) < 0 ||
        write_map_file(pid, "gid_map", map) != 0) {
        return errno;
    }
    if (snprintf(map, sizeof map, "0 %u 1\n", uid) < 0 ||
        write_map_file(pid, "uid_map", map) != 0) {
        return errno;
    }
    return 0;
}

static int read_spec(size_t *len_out)
{
    size_t len = 0;
    for (;;) {
        if (len > AEGIS_SPEC_MAX_BYTES) {
            return -1;
        }
        ssize_t r = read(FD_SPEC, g_spec_buf + len, sizeof g_spec_buf - len);
        if (r < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -2;
        }
        if (r == 0) {
            break;
        }
        len += (size_t)r;
    }
    *len_out = len;
    return 0;
}

static void kill_cell(int pidfd)
{
    long rc = aegis_sys_pidfd_send_signal(pidfd, SIGKILL, 0);
    (void)rc; /* ESRCH means it is already gone, which is what we want */
}

int aegis_boot_run(void)
{
    /* Descriptors: the three we were given must not leak into the payload, and nothing else may
     * be open (CLAUDE.md 5.1, 5.5). */
    for (int fd = FD_SPEC; fd <= FD_CONTROL; fd++) {
        int fl = fcntl(fd, F_GETFD);
        if (fl < 0 || fcntl(fd, F_SETFD, fl | FD_CLOEXEC) != 0) {
            return EXIT_INTERNAL;
        }
    }
    if (close_range(FIRST_UNUSED_FD, ~0U, 0) != 0) {
        status_layer("spec", 0, errno);
        return EXIT_INTERNAL;
    }
    (void)signal(SIGPIPE, SIG_IGN);

    size_t spec_len = 0;
    int rr = read_spec(&spec_len);
    if (rr != 0) {
        status_layer("spec", 0, rr == -1 ? E2BIG : errno);
        return EXIT_BAD_SPEC;
    }
    int prc = aegis_spec_parse(g_spec_buf, spec_len, &g_spec);
    if (prc != 0) {
        status_layer("spec", 0, -prc);
        return EXIT_BAD_SPEC;
    }

    /* The parent's namespace identities, for the child to compare against. */
    for (size_t i = 0; i < NS_COUNT; i++) {
        char link[64];
        if (snprintf(link, sizeof link, "/proc/self/ns/%s", k_ns[i].link) < 0 ||
            read_link_into(link, g_parent_ns[i], NS_LINK_CAP) != 0) {
            g_parent_ns[i][0] = '\0'; /* the child then fails this layer closed */
        }
    }

    int sync_pipe[2];
    int exec_pipe[2];
    if (pipe2(sync_pipe, O_CLOEXEC) != 0 || pipe2(exec_pipe, O_CLOEXEC) != 0) {
        status_layer("namespaces", 0, errno);
        return EXIT_NOT_ESTABLISHED;
    }
    g_exec_pipe_w = exec_pipe[1];

    int pidfd = -1;
    struct aegis_clone_args ca;
    memset(&ca, 0, sizeof ca);
    ca.flags = AEGIS_CLONE_NEWUSER | AEGIS_CLONE_NEWPID | AEGIS_CLONE_NEWNS | AEGIS_CLONE_NEWNET |
               AEGIS_CLONE_NEWIPC | AEGIS_CLONE_NEWUTS | AEGIS_CLONE_NEWCGROUP |
               AEGIS_CLONE_NEWTIME | AEGIS_CLONE_PIDFD;
    ca.pidfd = (uint64_t)(uintptr_t)&pidfd;
    ca.exit_signal = (uint64_t)SIGCHLD;

    unsigned int host_uid = (unsigned int)getuid();
    unsigned int host_gid = (unsigned int)getgid();

    long pid = aegis_sys_clone3(&ca, sizeof ca);
    if (pid < 0) {
        status_layer("namespaces", 0, errno);
        return EXIT_NOT_ESTABLISHED;
    }
    if (pid == 0) {
        close(sync_pipe[1]);
        close(exec_pipe[0]);
        child_main(sync_pipe[0]); /* never returns */
        _exit(92);
    }

    /* Parent. */
    close(sync_pipe[0]);
    close(exec_pipe[1]);
    g_exec_pipe_w = -1;

    const char go = 'G';
    int map_err = write_id_maps(pid, host_uid, host_gid);
    if (map_err != 0) {
        /* The child is still blocked on the sync pipe and holds no payload code. Report, kill it,
         * reap it, and stop: an exec pipe at EOF must never be read as "payload started". */
        status_layer("idmap", 0, map_err);
        kill_cell(pidfd);
        pid_t reaped;
        do {
            reaped = waitpid((pid_t)pid, NULL, 0);
        } while (reaped < 0 && errno == EINTR);
        return EXIT_NOT_ESTABLISHED;
    }
    ssize_t w;
    do {
        w = write(sync_pipe[1], &go, 1);
    } while (w < 0 && errno == EINTR);
    close(sync_pipe[1]);

    struct pollfd fds[3];
    fds[0].fd = pidfd;
    fds[0].events = POLLIN;
    fds[1].fd = FD_CONTROL;
    fds[1].events = POLLIN;
    fds[2].fd = exec_pipe[0];
    fds[2].events = POLLIN;
    int exec_state = 0; /* 0 pending, 1 payload exec'd, 2 failed (already reported) */
    int done = 0;
    while (!done) {
        int pr = poll(fds, 3, -1);
        if (pr < 0) {
            if (errno == EINTR) {
                continue;
            }
            kill_cell(pidfd);
            break;
        }
        if (fds[2].fd >= 0 && fds[2].revents != 0) {
            char b;
            ssize_t n = read(fds[2].fd, &b, 1);
            if (n > 0) {
                exec_state = 2;
            } else if (n == 0 && exec_state == 0) {
                exec_state = 1;
                status_num("started", pid);
            }
            if (n >= 0 || errno != EINTR) {
                close(fds[2].fd);
                fds[2].fd = -1;
            }
        }
        if (fds[1].fd >= 0 && fds[1].revents != 0) {
            char b = 0;
            ssize_t n = read(fds[1].fd, &b, 1);
            /* A 'K', EOF (the host went away) or a hard read error all mean: stop the cell. The
             * descriptor is then no longer polled, because EOF would otherwise spin. */
            if (n == 0 || (n > 0 && b == 'K') || (n < 0 && errno != EINTR)) {
                kill_cell(pidfd);
                fds[1].fd = -1;
            }
        }
        if (fds[0].revents != 0) {
            done = 1;
        }
    }

    /* The child has exited, so its end of the exec pipe is closed and this read cannot block. It
     * settles the case where exit and exec-pipe EOF were not seen in the same poll round. */
    if (exec_state == 0 && fds[2].fd >= 0) {
        char b;
        ssize_t n;
        do {
            n = read(fds[2].fd, &b, 1);
        } while (n < 0 && errno == EINTR);
        if (n > 0) {
            exec_state = 2;
        } else if (n == 0) {
            exec_state = 1;
            status_num("started", pid);
        }
    }

    int st = 0;
    pid_t wp;
    do {
        wp = waitpid((pid_t)pid, &st, 0);
    } while (wp < 0 && errno == EINTR);
    if (wp < 0) {
        return EXIT_INTERNAL;
    }
    if (exec_state != 1) {
        /* The child reported why it never ran; there is no payload outcome to add. If it died
         * without a record (killed before exec), say so rather than stay silent. */
        if (exec_state == 0 && WIFSIGNALED(st)) {
            status_layer("namespaces", 0, EINTR);
        }
        return EXIT_NOT_ESTABLISHED;
    }
    if (WIFEXITED(st)) {
        status_num("exited", WEXITSTATUS(st));
    } else if (WIFSIGNALED(st)) {
        status_num("signaled", WTERMSIG(st));
    }
    return EXIT_OK;
}
