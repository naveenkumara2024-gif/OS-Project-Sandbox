#define _GNU_SOURCE
#include "init.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
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
 * Trust: until Stage 4 drops capabilities the payload holds CAP_SYS_PTRACE in this user namespace
 * and can reach descriptor 4 through /proc/1/fd. The records written here are therefore about the
 * payload's own outcome and can be forged by it. Limit causes are read by the host from the
 * cgroup and do not pass through this process.
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

int aegis_init_run(char *const *payload_argv)
{
    if (getpid() != 1) {
        return EXIT_NOT_INIT;
    }
    if (payload_argv == NULL || payload_argv[0] == NULL) {
        return EXIT_INTERNAL;
    }
    /* The status descriptor was inherited without close-on-exec so it could reach this process;
     * the payload must not get it. */
    int fl = fcntl(FD_STATUS, F_GETFD);
    if (fl < 0 || fcntl(FD_STATUS, F_SETFD, fl | FD_CLOEXEC) != 0) {
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

    pid_t payload = fork();
    if (payload < 0) {
        status_fmt("layer exec fail %ld\n", errno);
        return EXIT_INTERNAL;
    }
    if (payload == 0) {
        close(exec_pipe[0]);
        (void)sigprocmask(SIG_UNBLOCK, &mask, NULL);
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
