#define _GNU_SOURCE
#include "boot.h"
#include "fsop.h"
#include "init.h"
#include "probe.h"

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

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "probe") == 0) {
        return aegis_probe_run();
    }
    if (argc == 2 && strcmp(argv[1], "boot") == 0) {
        return aegis_boot_run();
    }
    if (argc >= 4 && strcmp(argv[1], "init") == 0 && strcmp(argv[2], "--") == 0) {
        return aegis_init_run(&argv[3]);
    }
    if (argc >= 2 && strcmp(argv[1], "fsop") == 0) {
        return aegis_fsop_run(argc - 1, &argv[1]);
    }
    say("usage: aegis-cell probe | boot | init -- <argv...> | fsop <op> ...\n");
    return EXIT_USAGE;
}
