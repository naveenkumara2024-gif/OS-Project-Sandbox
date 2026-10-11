#define _GNU_SOURCE
#include "probe.h"

#include "sys.h"

#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stddef.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * Facts only (CLAUDE.md 3.1): every fact records what the kernel answered, where the answer came
 * from, and the errno if the call failed. Nothing here sets a flag, drops a capability or installs
 * a filter; the probe is read-only. The process is single-threaded, so the throwaway child used for
 * the user-namespace test is safe to fork.
 *
 * JSON is emitted by hand into a fixed buffer. Names and sources are string literals without
 * characters that need escaping, and values are booleans or integers, so no escaping is needed.
 */

typedef struct {
    char buf[4096];
    size_t len;
    int overflow;
    int facts;
} out_t;

static void out_raw(out_t *o, const char *s)
{
    size_t n = strlen(s);
    if (n > sizeof o->buf - o->len) {
        o->overflow = 1;
        return;
    }
    memcpy(o->buf + o->len, s, n);
    o->len += n;
}

static void out_long(out_t *o, long v)
{
    char tmp[24];
    size_t i = sizeof tmp;
    unsigned long u = v < 0 ? 0UL - (unsigned long)v : (unsigned long)v;
    do {
        i--;
        tmp[i] = (char)('0' + (u % 10UL));
        u /= 10UL;
    } while (u != 0UL);
    if (v < 0) {
        i--;
        tmp[i] = '-';
    }
    size_t n = sizeof tmp - i;
    if (n > sizeof o->buf - o->len) {
        o->overflow = 1;
        return;
    }
    memcpy(o->buf + o->len, tmp + i, n);
    o->len += n;
}

static void fact_open(out_t *o, const char *name)
{
    if (o->facts > 0) {
        out_raw(o, ",");
    }
    o->facts++;
    out_raw(o, "\"");
    out_raw(o, name);
    out_raw(o, "\":{\"value\":");
}

static void fact_close(out_t *o, const char *source, int err)
{
    out_raw(o, ",\"source\":\"");
    out_raw(o, source);
    out_raw(o, "\",\"errno\":");
    if (err == 0) {
        out_raw(o, "null");
    } else {
        out_long(o, err);
    }
    out_raw(o, "}");
}

static void fact_bool(out_t *o, const char *name, const char *source, int value, int err)
{
    fact_open(o, name);
    out_raw(o, value ? "true" : "false");
    fact_close(o, source, err);
}

static void fact_long(out_t *o, const char *name, const char *source, long value, int err)
{
    fact_open(o, name);
    out_long(o, value);
    fact_close(o, source, err);
}

static void fact_null(out_t *o, const char *name, const char *source, int err)
{
    fact_open(o, name);
    out_raw(o, "null");
    fact_close(o, source, err);
}

static void probe_clone3(out_t *o)
{
    errno = 0;
    long r = aegis_sys_clone3(NULL, 0);
    int e = errno;
    /* With size 0 the kernel rejects the call with EINVAL before it reads any argument, so EINVAL
     * means "implemented and reachable". ENOSYS, or EPERM from a seccomp filter, means it is not.
     * r >= 0 cannot happen for size 0. */
    fact_bool(o, "clone3", "syscall:clone3(size=0)", r < 0 && e == EINVAL, e);
}

static void probe_openat2(out_t *o)
{
    struct aegis_open_how how;
    memset(&how, 0, sizeof how);
    how.flags = (uint64_t)(O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    how.resolve = AEGIS_RESOLVE_BENEATH;
    errno = 0;
    long fd = aegis_sys_openat2(AT_FDCWD, ".", &how, sizeof how);
    int e = errno;
    if (fd < 0) {
        fact_bool(o, "openat2_resolve_beneath", "syscall:openat2(.,RESOLVE_BENEATH)", 0, e);
        return;
    }
    int cerr = 0;
    if (close((int)fd) != 0) {
        cerr = errno;
    }
    fact_bool(o, "openat2_resolve_beneath", "syscall:openat2(.,RESOLVE_BENEATH)", cerr == 0, cerr);
}

static void probe_pidfd_open(out_t *o)
{
    errno = 0;
    long fd = aegis_sys_pidfd_open((int)getpid(), 0);
    int e = errno;
    if (fd < 0) {
        fact_bool(o, "pidfd_open", "syscall:pidfd_open(self)", 0, e);
        return;
    }
    int cerr = 0;
    if (close((int)fd) != 0) {
        cerr = errno;
    }
    fact_bool(o, "pidfd_open", "syscall:pidfd_open(self)", cerr == 0, cerr);
}

static void probe_landlock(out_t *o)
{
    errno = 0;
    long v = aegis_sys_landlock_create_ruleset(NULL, 0, AEGIS_LANDLOCK_CREATE_RULESET_VERSION);
    int e = errno;
    if (v >= 0) {
        fact_long(o, "landlock_abi_version", "syscall:landlock_create_ruleset(VERSION)", v, 0);
    } else {
        fact_null(o, "landlock_abi_version", "syscall:landlock_create_ruleset(VERSION)", e);
    }
}

static void probe_seccomp_mode(out_t *o)
{
    errno = 0;
    int m = prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
    int e = errno;
    if (m >= 0) {
        fact_long(o, "seccomp_mode", "prctl:PR_GET_SECCOMP", m, 0);
    } else {
        fact_null(o, "seccomp_mode", "prctl:PR_GET_SECCOMP", e);
    }
}

static void probe_no_new_privs(out_t *o)
{
    errno = 0;
    int v = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
    int e = errno;
    if (v >= 0) {
        fact_long(o, "no_new_privs", "prctl:PR_GET_NO_NEW_PRIVS", v, 0);
    } else {
        fact_null(o, "no_new_privs", "prctl:PR_GET_NO_NEW_PRIVS", e);
    }
}

static void probe_unshare_newuser(out_t *o)
{
    static const char name[] = "unshare_newuser";
    static const char source[] = "fork+unshare(CLONE_NEWUSER)";

    pid_t pid = fork();
    if (pid < 0) {
        fact_bool(o, name, source, 0, errno);
        return;
    }
    if (pid == 0) {
        /* Child: the namespace dies with it, so the parent is unaffected. The errno value fits an
         * exit status (Linux errno values are below 256). */
        if (unshare(CLONE_NEWUSER) == 0) {
            _exit(0);
        }
        _exit(errno);
    }

    int status = 0;
    pid_t w;
    do {
        w = waitpid(pid, &status, 0);
    } while (w < 0 && errno == EINTR);
    if (w < 0) {
        fact_bool(o, name, source, 0, errno);
        return;
    }
    if (WIFEXITED(status)) {
        int code = WEXITSTATUS(status);
        fact_bool(o, name, source, code == 0, code);
        return;
    }
    /* The child was killed by a signal: report a protocol-level failure rather than guess. */
    fact_bool(o, name, source, 0, EPROTO);
}

static int write_all(int fd, const char *p, size_t n)
{
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

int aegis_probe_run(void)
{
    out_t o;
    memset(&o, 0, sizeof o);

    out_raw(&o, "{\"schema\":1,\"helper\":\"aegis-cell\",\"helper_version\":\"" AEGIS_CELL_VERSION
                "\",\"facts\":{");
    probe_clone3(&o);
    probe_openat2(&o);
    probe_pidfd_open(&o);
    probe_landlock(&o);
    probe_seccomp_mode(&o);
    probe_no_new_privs(&o);
    probe_unshare_newuser(&o);
    out_raw(&o, "}}\n");

    if (o.overflow != 0) {
        return 70;
    }
    if (write_all(STDOUT_FILENO, o.buf, o.len) != 0) {
        return 70;
    }
    return 0;
}
