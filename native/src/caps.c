#define _GNU_SOURCE
#include "caps.h"

#include "sys.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

/*
 * Capability drop (prompt section 4.2). The order matters: PR_SET_SECUREBITS and PR_CAPBSET_DROP
 * need CAP_SETPCAP, which capset removes last. PR_CAP_AMBIENT and friends come from
 * <linux/prctl.h> via <sys/prctl.h>.
 */

int aegis_caps_drop(void)
{
    /* 1. Securebits first: with NOROOT a later exec of a set-uid-root file or of a file with
     * capabilities cannot hand anything back, and the locks stop the payload undoing it. */
    if (prctl(PR_SET_SECUREBITS, (unsigned long)AEGIS_SECUREBITS_WANTED, 0UL, 0UL, 0UL) != 0) {
        return -1;
    }
    /* 2. Ambient set. */
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0UL, 0UL, 0UL) != 0) {
        return -1;
    }
    /* 3. Bounding set, while CAP_SETPCAP is still held. PR_CAPBSET_READ answers EINVAL once the
     * number is past the kernel's last capability, so the loop needs no procfs and no constant. */
    for (unsigned long c = 0; c < 64UL; c++) {
        int r = prctl(PR_CAPBSET_READ, c, 0UL, 0UL, 0UL);
        if (r < 0) {
            if (errno == EINVAL) {
                break;
            }
            return -1;
        }
        if (r == 1 && prctl(PR_CAPBSET_DROP, c, 0UL, 0UL, 0UL) != 0) {
            return -1;
        }
    }
    /* 4. Inheritable, permitted, effective. Version 3 takes two 32-bit words per set. */
    struct __user_cap_header_struct hdr;
    struct __user_cap_data_struct data[2];
    memset(&hdr, 0, sizeof hdr);
    memset(data, 0, sizeof data);
    hdr.version = _LINUX_CAPABILITY_VERSION_3;
    hdr.pid = 0;
    if (aegis_sys_capset(&hdr, data) != 0) {
        return -1;
    }
    return 0;
}

static int parse_hex_line(const char *buf, const char *key, uint64_t *out)
{
    size_t klen = strlen(key);
    const char *p = buf;
    while (p != NULL && *p != '\0') {
        if (strncmp(p, key, klen) == 0) {
            const char *v = p + klen;
            while (*v == ' ' || *v == '\t') {
                v++;
            }
            uint64_t acc = 0;
            int digits = 0;
            for (;; v++) {
                unsigned d;
                if (*v >= '0' && *v <= '9') {
                    d = (unsigned)(*v - '0');
                } else if (*v >= 'a' && *v <= 'f') {
                    d = (unsigned)(*v - 'a') + 10U;
                } else {
                    break;
                }
                acc = (acc << 4) | d;
                digits++;
            }
            if (digits == 0 || digits > 16 || *v != '\n') {
                return -1;
            }
            *out = acc;
            return 0;
        }
        p = strchr(p, '\n');
        if (p != NULL) {
            p++;
        }
    }
    return -1;
}

int aegis_caps_read(aegis_capstate_t *out)
{
    static char buf[8192];
    int fd = open("/proc/self/status", O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return -1;
    }
    size_t len = 0;
    for (;;) {
        if (len == sizeof buf - 1U) {
            close(fd);
            errno = E2BIG;
            return -1;
        }
        ssize_t r = read(fd, buf + len, sizeof buf - 1U - len);
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
    buf[len] = '\0';
    if (parse_hex_line(buf, "CapInh:", &out->inheritable) != 0 ||
        parse_hex_line(buf, "CapPrm:", &out->permitted) != 0 ||
        parse_hex_line(buf, "CapEff:", &out->effective) != 0 ||
        parse_hex_line(buf, "CapBnd:", &out->bounding) != 0 ||
        parse_hex_line(buf, "CapAmb:", &out->ambient) != 0) {
        errno = EPROTO;
        return -1;
    }
    return 0;
}

int aegis_caps_verify_dropped(void)
{
    aegis_capstate_t s;
    if (aegis_caps_read(&s) != 0) {
        return -1;
    }
    if (s.inheritable != 0 || s.permitted != 0 || s.effective != 0 || s.bounding != 0 ||
        s.ambient != 0) {
        errno = EPERM;
        return -1;
    }
    int bits = prctl(PR_GET_SECUREBITS, 0UL, 0UL, 0UL, 0UL);
    if (bits < 0) {
        return -1;
    }
    if (((unsigned)bits & AEGIS_SECUREBITS_WANTED) != AEGIS_SECUREBITS_WANTED) {
        errno = EPERM;
        return -1;
    }
    return 0;
}
