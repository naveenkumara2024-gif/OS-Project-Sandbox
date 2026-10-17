#define _GNU_SOURCE
#include "boot.h"
#include "fsop.h"
#include "init.h"
#include "probe.h"
#include "spec.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* sysexits.h EX_USAGE; spelled out so the exit status is documented where it is used. */
enum { EXIT_USAGE = 64 };

static void say(const char *s)
{
    /* Diagnostics only. If stderr is closed there is nothing sensible left to do. */
    ssize_t w = write(STDERR_FILENO, s, strlen(s));
    (void)w;
}

/* Parses `init [--require <mask>] [--ablate <mask>] -- argv...`; returns the index of the first
 * payload argument, or 0 when the command line is malformed. The only caller is boot.c, but the
 * binary is also reachable by a person, so this is parsed strictly. */
static int parse_init_args(int argc, char **argv, aegis_init_opts_t *opts)
{
    opts->require_mask = AEGIS_REQ_DEFAULT;
    opts->ablate_mask = 0;
    int i = 2;
    while (i < argc && strcmp(argv[i], "--") != 0) {
        if (strcmp(argv[i], "--require") == 0 && i + 1 < argc) {
            char *end = NULL;
            errno = 0;
            unsigned long v = strtoul(argv[i + 1], &end, 10);
            if (errno != 0 || end == argv[i + 1] || *end != '\0' ||
                (v & ~(unsigned long)AEGIS_REQ_ALL) != 0UL) {
                return 0;
            }
            opts->require_mask = (uint32_t)v;
            i += 2;
#ifdef AEGIS_ENABLE_ABLATION
        } else if (strcmp(argv[i], "--ablate") == 0 && i + 1 < argc) {
            char *end = NULL;
            errno = 0;
            unsigned long v = strtoul(argv[i + 1], &end, 10);
            if (errno != 0 || end == argv[i + 1] || *end != '\0' ||
                (v & ~(unsigned long)AEGIS_REQ_ALL) != 0UL) {
                return 0;
            }
            opts->ablate_mask = (uint32_t)v;
            i += 2;
#endif
        } else {
            return 0;
        }
    }
    if (i + 1 >= argc || strcmp(argv[i], "--") != 0) {
        return 0;
    }
    return i + 1;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "probe") == 0) {
        return aegis_probe_run();
    }
    if (argc == 2 && strcmp(argv[1], "boot") == 0) {
        return aegis_boot_run();
    }
    if (argc >= 4 && strcmp(argv[1], "init") == 0) {
        aegis_init_opts_t opts;
        int first = parse_init_args(argc, argv, &opts);
        if (first == 0) {
            say("usage: aegis-cell init [--require <mask>] -- <argv...>\n");
            return EXIT_USAGE;
        }
        return aegis_init_run(&argv[first], &opts);
    }
    if (argc >= 2 && strcmp(argv[1], "fsop") == 0) {
        return aegis_fsop_run(argc - 1, &argv[1]);
    }
    say("usage: aegis-cell probe | boot | init -- <argv...> | fsop <op> ...\n");
    return EXIT_USAGE;
}
