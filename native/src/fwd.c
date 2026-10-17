#define _GNU_SOURCE
#include "fwd.h"

#include "landlock.h"
#include "seccomp.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * The forwarder is the cell's only way to the broker. It is deliberately dumb: it relays bytes
 * between a loopback TCP connection and a Unix socket and decides nothing. The broker, on the
 * host, parses and judges every request. A connection is handled by a forked child, so a stuck
 * peer blocks only its own relay, and the fixed limit on children bounds the whole.
 */

static void fail_setup(int ready_fd, int err_no)
{
    char msg[2] = {'F', (char)(err_no & 0xff)};
    ssize_t w = write(ready_fd, msg, sizeof msg);
    (void)w;
    _exit(70);
}

/* Moves bytes both ways until both directions have ended. Half-close is passed on. */
static void relay(int a, int b)
{
    char buf[8192];
    struct pollfd p[2] = {{a, POLLIN, 0}, {b, POLLIN, 0}};
    int open_dir[2] = {1, 1};
    while (open_dir[0] || open_dir[1]) {
        p[0].fd = open_dir[0] ? a : -1;
        p[1].fd = open_dir[1] ? b : -1;
        int pr = poll(p, 2, -1);
        if (pr < 0) {
            if (errno == EINTR) {
                continue;
            }
            return;
        }
        for (int i = 0; i < 2; i++) {
            if (!open_dir[i] || (p[i].revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
                continue;
            }
            int from = i == 0 ? a : b;
            int to = i == 0 ? b : a;
            ssize_t n = read(from, buf, sizeof buf);
            if (n < 0 && errno == EINTR) {
                continue;
            }
            if (n <= 0) {
                open_dir[i] = 0;
                (void)shutdown(to, SHUT_WR);
                continue;
            }
            size_t off = 0;
            while (off < (size_t)n) {
                ssize_t w = write(to, buf + off, (size_t)n - off);
                if (w < 0) {
                    if (errno == EINTR) {
                        continue;
                    }
                    return;
                }
                off += (size_t)w;
            }
        }
    }
}

static void handle(int client)
{
    int u = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (u < 0) {
        _exit(1);
    }
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    memcpy(sa.sun_path, AEGIS_BROKER_SOCK_IN_CELL, sizeof AEGIS_BROKER_SOCK_IN_CELL);
    if (connect(u, (const struct sockaddr *)&sa, sizeof sa) != 0) {
        _exit(1);
    }
    relay(client, u);
    _exit(0);
}

void aegis_fwd_run(int ready_fd)
{
    /* If init goes away the forwarder goes with it. */
    (void)prctl(PR_SET_PDEATHSIG, SIGKILL);
    /* init blocks a few signals for its signalfd; that mask is not inherited here. */
    sigset_t none;
    (void)sigemptyset(&none);
    (void)sigprocmask(SIG_SETMASK, &none, NULL);

    /* Nothing but the ready pipe: the status descriptor in particular must not be reachable. */
    if (ready_fd > 3 && close_range(3, (unsigned)ready_fd - 1U, 0) != 0) {
        fail_setup(ready_fd, errno);
    }
    (void)close_range((unsigned)ready_fd + 1U, ~0U, 0);
    int devnull = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (devnull < 0 || dup2(devnull, 0) < 0 || dup2(devnull, 1) < 0 || dup2(devnull, 2) < 0) {
        fail_setup(ready_fd, errno);
    }

    aegis_landlock_plan_t plan = {0, 0, AEGIS_FWD_PORT};
    aegis_landlock_info_t info;
    int ll = aegis_landlock_apply(&plan, &info);
    int ll_errno = ll == 0 ? 0 : errno;
    if (ll != 0 && info.abi >= 4) {
        /* The ruleset exists on this kernel but could not be applied: do not run unrestricted. */
        fail_setup(ready_fd, ll_errno);
    }
    if (aegis_seccomp_install() != 0) {
        fail_setup(ready_fd, errno);
    }

    int l = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (l < 0) {
        fail_setup(ready_fd, errno);
    }
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons(AEGIS_FWD_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int one = 1;
    (void)setsockopt(l, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    if (bind(l, (const struct sockaddr *)&addr, sizeof addr) != 0 || listen(l, 16) != 0) {
        fail_setup(ready_fd, errno);
    }
    char ok = 'R';
    ssize_t w = write(ready_fd, &ok, 1);
    (void)w;
    close(ready_fd);

    int active = 0;
    for (;;) {
        for (;;) {
            int st;
            pid_t r = waitpid(-1, &st, WNOHANG);
            if (r <= 0) {
                break;
            }
            active--;
        }
        struct pollfd p = {l, POLLIN, 0};
        if (poll(&p, 1, 500) <= 0) {
            continue;
        }
        int c = accept4(l, NULL, NULL, SOCK_CLOEXEC);
        if (c < 0) {
            continue;
        }
        if (active >= AEGIS_FWD_MAX_CONN) {
            close(c);
            continue;
        }
        pid_t child = fork();
        if (child == 0) {
            close(l);
            handle(c);
        }
        if (child > 0) {
            active++;
        }
        close(c);
    }
}
