#define _GNU_SOURCE
#include "fsop.h"

#include "sys.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { EXIT_OK = 0, EXIT_PATH = 1, EXIT_REFUSED = 2, EXIT_TOO_BIG = 3, EXIT_USAGE = 64 };
enum { COPY_BUF_BYTES = 65536 };

static void say(const char *s)
{
    ssize_t w = write(STDOUT_FILENO, s, strlen(s));
    (void)w;
}

/* Opens dirfd/rel with openat2, confined to beneath dirfd and never through a symlink. */
static int confined_open(int dirfd, const char *rel, uint64_t flags, uint64_t mode)
{
    struct aegis_open_how how;
    how.flags = flags;
    how.mode = mode;
    how.resolve = AEGIS_RESOLVE_BENEATH;
    long fd = aegis_sys_openat2(dirfd, rel, &how, sizeof how);
    return (int)fd;
}

/* mkdir -p beneath dirfd, one confined component at a time, without ever leaving dirfd's tree. */
/* Ensures one directory component (buf, NUL-terminated at this prefix) exists beneath dirfd. */
static int ensure_dir(int dirfd, const char *prefix)
{
    if (prefix[0] == '\0') {
        return 0;
    }
    struct aegis_open_how how;
    how.flags = O_DIRECTORY;
    how.mode = 0;
    how.resolve = AEGIS_RESOLVE_BENEATH;
    long fd = aegis_sys_openat2(dirfd, prefix, &how, sizeof how);
    if (fd >= 0) {
        close((int)fd);
        return 0;
    }
    return (mkdirat(dirfd, prefix, 0755) == 0 || errno == EEXIST) ? 0 : -1;
}

/* mkdir -p for `rel`, which is itself a full directory path to create (not a file's parent of
 * some longer path): every embedded slash marks a prefix to create, and the loop below must also
 * create the path named by `rel` in full, which has no trailing slash to trigger that otherwise. */
static int confined_mkdirs(int dirfd, const char *rel)
{
    char buf[4096];
    size_t n = strlen(rel);
    if (n >= sizeof buf) {
        errno = ENAMETOOLONG;
        return -1;
    }
    memcpy(buf, rel, n + 1);
    for (size_t i = 0; i < n; i++) {
        if (buf[i] != '/') {
            continue;
        }
        buf[i] = '\0';
        if (ensure_dir(dirfd, buf) != 0) {
            return -1;
        }
        buf[i] = '/';
    }
    return ensure_dir(dirfd, buf);
}

static int run_ingest_check(const char *root, const char *rel)
{
    int dirfd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dirfd < 0) {
        say("refused: root\n");
        return EXIT_PATH;
    }
    int fd = confined_open(dirfd, rel, O_RDONLY, 0);
    close(dirfd);
    if (fd < 0) {
        say("refused: escapes the allowed root\n");
        return EXIT_REFUSED;
    }
    close(fd);
    say("ok\n");
    return EXIT_OK;
}

static int run_commit_copy(const char *root, const char *rel, const char *src, const char *maxs)
{
    char *end = NULL;
    long long max_bytes = strtoll(maxs, &end, 10);
    if (end == NULL || *end != '\0' || max_bytes < 0) {
        say("refused: bad size limit\n");
        return EXIT_PATH;
    }

    int dirfd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dirfd < 0) {
        say("refused: destination root\n");
        return EXIT_PATH;
    }

    const char *slash = strrchr(rel, '/');
    if (slash != NULL) {
        char parent[4096];
        size_t len = (size_t)(slash - rel);
        if (len >= sizeof parent) {
            close(dirfd);
            say("refused: path too long\n");
            return EXIT_PATH;
        }
        memcpy(parent, rel, len);
        parent[len] = '\0';
        if (confined_mkdirs(dirfd, parent) != 0) {
            close(dirfd);
            say("refused: cannot create the destination directory\n");
            return EXIT_REFUSED;
        }
    }

    /* O_NOFOLLOW plus RESOLVE_BENEATH: the final component is never a symlink and no component
     * anywhere in the path may be one either way out of the root (CLAUDE.md 6.3). dirfd stays
     * open until the function returns, so every failure path below can unlink what it created
     * instead of leaving a stray empty file at the destination. */
    int outfd =
        confined_open(dirfd, rel, (uint64_t)(O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW), 0644);
    if (outfd < 0) {
        close(dirfd);
        say("refused: escapes the allowed root, or the target is not a plain file\n");
        return EXIT_REFUSED;
    }

#define FAIL_AND_UNLINK(infd_, msg, code)                                                          \
    do {                                                                                           \
        if ((infd_) >= 0) {                                                                        \
            close(infd_);                                                                          \
        }                                                                                          \
        close(outfd);                                                                              \
        unlinkat(dirfd, rel, 0);                                                                   \
        close(dirfd);                                                                              \
        say(msg);                                                                                  \
        return (code);                                                                             \
    } while (0)

    struct stat st;
    if (fstat(outfd, &st) != 0 || !S_ISREG(st.st_mode) || (st.st_mode & (S_ISUID | S_ISGID)) != 0) {
        FAIL_AND_UNLINK(-1,
                        "refused: target is not an ordinary file, or has set-uid/set-gid bits\n",
                        EXIT_REFUSED);
    }

    /* Defence in depth: the control plane already filters symlinks out of what it asks fsop to
     * copy (from the diff metadata), but fsop does not trust that and refuses one itself too. */
    struct stat srcst;
    if (lstat(src, &srcst) != 0) {
        FAIL_AND_UNLINK(-1, "refused: source\n", EXIT_PATH);
    }
    if (!S_ISREG(srcst.st_mode)) {
        FAIL_AND_UNLINK(-1, "refused: source is not a plain file\n", EXIT_REFUSED);
    }
    int infd = open(src, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (infd < 0) {
        FAIL_AND_UNLINK(-1, "refused: source\n", EXIT_PATH);
    }

    static unsigned char buf[COPY_BUF_BYTES];
    long long total = 0;
    for (;;) {
        ssize_t r = read(infd, buf, sizeof buf);
        if (r < 0) {
            FAIL_AND_UNLINK(infd, "refused: read error on the source\n", EXIT_PATH);
        }
        if (r == 0) {
            break;
        }
        total += r;
        if (total > max_bytes) {
            FAIL_AND_UNLINK(infd, "refused: source exceeds the size cap\n", EXIT_TOO_BIG);
        }
        ssize_t off = 0;
        while (off < r) {
            ssize_t w = write(outfd, buf + off, (size_t)(r - off));
            if (w < 0) {
                FAIL_AND_UNLINK(infd, "refused: write error on the destination\n", EXIT_PATH);
            }
            off += w;
        }
    }
#undef FAIL_AND_UNLINK
    close(infd);
    close(outfd);
    close(dirfd);
    char line[64];
    int n = snprintf(line, sizeof line, "ok %lld\n", total);
    if (n > 0 && (size_t)n < sizeof line) {
        say(line);
    }
    return EXIT_OK;
}

int aegis_fsop_run(int argc, char **argv)
{
    if (argc >= 4 && strcmp(argv[1], "ingest-check") == 0) {
        return run_ingest_check(argv[2], argv[3]);
    }
    if (argc >= 6 && strcmp(argv[1], "commit-copy") == 0) {
        return run_commit_copy(argv[2], argv[3], argv[4], argv[5]);
    }
    say("usage: aegis-cell fsop ingest-check <root> <rel> | commit-copy <root> <rel> <src> "
        "<max>\n");
    return EXIT_USAGE;
}
