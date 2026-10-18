#define _GNU_SOURCE
#include "init.h"

#include "caps.h"
#include "fwd.h"
#include "landlock.h"
#include "seccomp.h"
#include "spec.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * Why this exists (blueprint "PID 1 is special"): the first process of a pid namespace ignores
 * signals it has no handler for, so a plain payload as PID 1 shrugs off SIGTERM, and it adopts
 * orphans but never reaps them unless it waits. This process is that supervisor. It is a fresh
 * exec of the helper binary (bound read-only into the cell), so it carries no launch spec and no
 * host paths in memory.
 *
 * Trust (Stage 4): this process makes itself non-dumpable, sets no_new_privs and drops every
 * capability before it forks, so the payload (which inherits that and never gets a capability
 * back) cannot ptrace init or read the fd, mem and environ files under /proc/1. Descriptor 4 is
 * close-on-exec before the payload's execve. The records written here therefore cannot be forged
 * from inside the cell. Limit causes are read by the host from the cgroup and do not pass through
 * this process.
 *
 * Order (prompt section 4.1): dumpable, no_new_privs, capabilities; fork; in the payload child
 * Landlock, then seccomp last, then execve. no_new_privs comes first because an unprivileged
 * process may only install a filter or a ruleset once it is set; the filter comes last so nothing
 * after it needs a denied system call.
 */

enum { FD_STATUS = 4, EXIT_OK = 0, EXIT_NOT_INIT = 64, EXIT_INTERNAL = 70 };

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
            return;
        }
        off += (size_t)w;
    }
}

static void status_fmt(const char *fmt, long v)
{
    char line[96];
    int n = snprintf(line, sizeof line, fmt, v);
    if (n > 0 && (size_t)n < sizeof line) {
        status_line(line);
    }
}

static void report_layer(const char *layer, int ok_flag, int err_no)
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

static int required(const aegis_init_opts_t *o, uint32_t bit)
{
    return (o->require_mask & bit) != 0U;
}

/* Ablation builds only: the layer is reported as unavailable without being tried. */
static int ablated(const aegis_init_opts_t *o, uint32_t bit)
{
    return (o->ablate_mask & bit) != 0U;
}

/* A layer is only "ok" once it has been read back from the kernel. */
static int establish_no_new_privs(void)
{
    if (prctl(PR_SET_NO_NEW_PRIVS, 1UL, 0UL, 0UL, 0UL) != 0) {
        return errno;
    }
    if (prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL) != 1) {
        return EPERM;
    }
    return 0;
}

static int establish_caps_dropped(void)
{
    if (aegis_caps_drop() != 0 || aegis_caps_verify_dropped() != 0) {
        return errno != 0 ? errno : EPERM;
    }
    return 0;
}

/* Runs in the payload child, before execve. Returns 0 to go on, or -1 when a required layer could
 * not be established; the layer's own record has already been written. */
static int harden_payload(const aegis_init_opts_t *opts)
{
    /* Landlock: optional unless the manifest requires it. */
    int ll_errno = 0;
    aegis_landlock_info_t info;
    memset(&info, 0, sizeof info);
    /* A brokered payload may connect to the forwarder's port and to nothing else. */
    const aegis_landlock_plan_t plan = {1, opts->broker ? AEGIS_FWD_PORT : 0, 0};
    if (ablated(opts, AEGIS_REQ_LANDLOCK)) {
        ll_errno = EOPNOTSUPP;
    } else if (aegis_landlock_apply(&plan, &info) != 0) {
        ll_errno = errno != 0 ? errno : EPERM;
    }
    if (ll_errno == 0) {
        report_layer("landlock", 1, 0);
        status_fmt("landlock_abi %ld\n", (long)info.abi);
    } else {
        report_layer("landlock", 0, ll_errno);
        if (required(opts, AEGIS_REQ_LANDLOCK)) {
            return -1;
        }
    }

    /* seccomp is last. The status write below stays allowed under the filter. */
    int sc_errno = 0;
    if (ablated(opts, AEGIS_REQ_SECCOMP)) {
        sc_errno = EOPNOTSUPP;
    } else if (aegis_seccomp_install() != 0) {
        sc_errno = errno != 0 ? errno : EPERM;
    } else if (prctl(PR_GET_SECCOMP, 0UL, 0UL, 0UL, 0UL) != 2) {
        sc_errno = EPERM; /* SECCOMP_MODE_FILTER */
    }
    if (sc_errno == 0) {
        report_layer("seccomp", 1, 0);
    } else {
        report_layer("seccomp", 0, sc_errno);
        if (required(opts, AEGIS_REQ_SECCOMP)) {
            return -1;
        }
    }
    return 0;
}

/*
 * Starts the egress forwarder (a child of this process, same image) and waits until it reports
 * that it is listening. Returns 0, or an errno. The forwarder has its own Landlock domain and the
 * seccomp filter; see fwd.c.
 */
static int start_forwarder(void)
{
    int fds[2];
    if (pipe2(fds, O_CLOEXEC) != 0) {
        return errno;
    }
    pid_t pid = fork();
    if (pid < 0) {
        int e = errno;
        close(fds[0]);
        close(fds[1]);
        return e;
    }
    if (pid == 0) {
        close(fds[0]);
        aegis_fwd_run(fds[1]);
    }
    close(fds[1]);
    struct pollfd p = {fds[0], POLLIN, 0};
    int pr;
    do {
        pr = poll(&p, 1, 5000);
    } while (pr < 0 && errno == EINTR);
    char msg[2] = {0, 0};
    ssize_t n = pr > 0 ? read(fds[0], msg, sizeof msg) : -1;
    close(fds[0]);
    if (pr > 0 && n >= 1 && msg[0] == 'R') {
        return 0;
    }
    (void)kill(pid, SIGKILL);
    if (pr == 0) {
        return ETIMEDOUT;
    }
    return (n >= 2 && msg[0] == 'F' && msg[1] != 0) ? (int)(unsigned char)msg[1] : EPROTO;
}

static int build_mask(sigset_t *m)
{
    static const int sigs[] = {SIGCHLD, SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
    if (sigemptyset(m) != 0) {
        return -1;
    }
    for (size_t i = 0; i < sizeof sigs / sizeof *sigs; i++) {
        if (sigaddset(m, sigs[i]) != 0) {
            return -1;
        }
    }
    return 0;
}

/* Reports which capped tmpfs mounts ended up full; the control plane turns that into disk_limit. */
static void report_full_mounts(void)
{
    static const char *const paths[] = {"/", "/tmp", "/dev/shm"};
    for (size_t i = 0; i < sizeof paths / sizeof *paths; i++) {
        struct statvfs sv;
        if (statvfs(paths[i], &sv) == 0 && sv.f_blocks > 0 && sv.f_bavail == 0) {
            char line[64];
            int n = snprintf(line, sizeof line, "full %s\n", paths[i]);
            if (n > 0 && (size_t)n < sizeof line) {
                status_line(line);
            }
        }
    }
}

int aegis_init_run(char *const *payload_argv, const aegis_init_opts_t *opts)
{
    if (getpid() != 1) {
        return EXIT_NOT_INIT;
    }
    if (payload_argv == NULL || payload_argv[0] == NULL || opts == NULL) {
        return EXIT_INTERNAL;
    }
    /* The status descriptor was inherited without close-on-exec so it could reach this process;
     * the payload must not get it. */
    int fl = fcntl(FD_STATUS, F_GETFD);
    if (fl < 0 || fcntl(FD_STATUS, F_SETFD, fl | FD_CLOEXEC) != 0) {
        return EXIT_INTERNAL;
    }

    /* Hardening of init itself. An exec resets the dumpable flag, so this is done here and not in
     * the boot child. Non-dumpable makes the files under /proc/1 and ptrace need CAP_SYS_PTRACE,
     * which nothing in the cell has after the drop below. */
    if (prctl(PR_SET_DUMPABLE, 0UL, 0UL, 0UL, 0UL) != 0 ||
        prctl(PR_GET_DUMPABLE, 0UL, 0UL, 0UL, 0UL) != 0) {
        status_fmt("layer init fail %ld\n", errno != 0 ? errno : EPERM);
        return EXIT_INTERNAL;
    }
    int nnp_errno = ablated(opts, AEGIS_REQ_NO_NEW_PRIVS) ? EOPNOTSUPP : establish_no_new_privs();
    report_layer("no_new_privs", nnp_errno == 0, nnp_errno);
    if (nnp_errno != 0 && required(opts, AEGIS_REQ_NO_NEW_PRIVS)) {
        return EXIT_INTERNAL;
    }
    int caps_errno = ablated(opts, AEGIS_REQ_CAPS_DROPPED) ? EOPNOTSUPP : establish_caps_dropped();
    report_layer("caps_dropped", caps_errno == 0, caps_errno);
    if (caps_errno != 0 && required(opts, AEGIS_REQ_CAPS_DROPPED)) {
        return EXIT_INTERNAL;
    }

    sigset_t mask;
    if (build_mask(&mask) != 0 || sigprocmask(SIG_BLOCK, &mask, NULL) != 0) {
        status_fmt("layer init fail %ld\n", errno);
        return EXIT_INTERNAL;
    }
    int sfd = signalfd(-1, &mask, SFD_CLOEXEC);
    if (sfd < 0) {
        status_fmt("layer init fail %ld\n", errno);
        return EXIT_INTERNAL;
    }
    int exec_pipe[2];
    if (pipe2(exec_pipe, O_CLOEXEC) != 0) {
        status_fmt("layer init fail %ld\n", errno);
        return EXIT_INTERNAL;
    }
    status_line("layer init ok\n");

    if (opts->broker) {
        int fe = start_forwarder();
        report_layer("broker", fe == 0, fe);
        if (fe != 0) {
            return EXIT_INTERNAL; /* a brokered cell without its broker path does not run */
        }
    }

    pid_t payload = fork();
    if (payload < 0) {
        status_fmt("layer exec fail %ld\n", errno);
        return EXIT_INTERNAL;
    }
    if (payload == 0) {
        close(exec_pipe[0]);
        (void)sigprocmask(SIG_UNBLOCK, &mask, NULL);
        if (harden_payload(opts) != 0) {
            /* The layer's record is written; the byte tells init the report is already made. */
            char f = 'F';
            ssize_t fw = write(exec_pipe[1], &f, 1);
            (void)fw;
            _exit(127);
        }
        execve(payload_argv[0], payload_argv, environ);
        /* Still here: execve failed and descriptor 4 is still open (close-on-exec only fires on
         * success). Say why, then tell init through the pipe that the report is already made. */
        status_fmt("layer exec fail %ld\n", errno);
        char b = 'F';
        ssize_t w = write(exec_pipe[1], &b, 1);
        (void)w;
        _exit(127);
    }
    close(exec_pipe[1]);

    /* EOF on the pipe means the payload's execve succeeded; a byte means it failed. */
    char b;
    ssize_t n;
    do {
        n = read(exec_pipe[0], &b, 1);
    } while (n < 0 && errno == EINTR);
    close(exec_pipe[0]);
    int exec_ok = (n == 0);
    if (exec_ok) {
        status_fmt("started %ld\n", (long)payload);
    }

    int payload_done = 0;
    int payload_status = 0;
    while (!payload_done) {
        struct signalfd_siginfo si;
        ssize_t r = read(sfd, &si, sizeof si);
        if (r != (ssize_t)sizeof si) {
            if (r < 0 && errno != EINTR) {
                break;
            }
            continue;
        }
        if (si.ssi_signo == SIGCHLD) {
            for (;;) {
                int st = 0;
                pid_t w = waitpid(-1, &st, WNOHANG);
                if (w <= 0) {
                    break;
                }
                if (w == payload) {
                    payload_done = 1;
                    payload_status = st;
                }
            }
        } else {
            /* PID 1 only sees these because they are blocked and read here; the payload is the
             * one that should react to them. */
            (void)kill(payload, (int)si.ssi_signo);
        }
    }

    if (exec_ok) {
        if (WIFEXITED(payload_status)) {
            status_fmt("exited %ld\n", WEXITSTATUS(payload_status));
        } else if (WIFSIGNALED(payload_status)) {
            status_fmt("signaled %ld\n", WTERMSIG(payload_status));
        }
        report_full_mounts();
    }

    /* The payload is gone, so the cell is over. Take down whatever it left behind and reap it. */
    (void)kill(-1, SIGKILL);
    for (;;) {
        pid_t w = waitpid(-1, NULL, 0);
        if (w < 0 && errno != EINTR) {
            break;
        }
    }
    return EXIT_OK;
}
