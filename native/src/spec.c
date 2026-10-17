#include "spec.h"

#include <string.h>

static uint16_t rd16(const uint8_t *p)
{
    return (uint16_t)((unsigned)p[0] | ((unsigned)p[1] << 8));
}

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t rd64(const uint8_t *p)
{
    return (uint64_t)rd32(p) | ((uint64_t)rd32(p + 4) << 32);
}

/*
 * A string field must end in exactly one NUL, contain no other NUL, and be at most
 * AEGIS_SPEC_MAX_STRING bytes including that NUL. The returned pointer aims into the buffer.
 */
static int take_string(const uint8_t *p, size_t len, const char **out)
{
    if (len < 1U || len > AEGIS_SPEC_MAX_STRING || p[len - 1U] != 0U) {
        return AEGIS_SPEC_E_STRING;
    }
    if (memchr(p, 0, len - 1U) != NULL) {
        return AEGIS_SPEC_E_STRING;
    }
    *out = (const char *)p;
    return 0;
}

/* Absolute, not the bare root, and no ".." component. "." and empty components are harmless but
 * also rejected so a path has one spelling. */
static int check_abs_path(const char *s)
{
    if (s[0] != '/' || s[1] == '\0') {
        return AEGIS_SPEC_E_PATH; /* relative, or the bare root */
    }
    const char *c = s + 1;
    while (*c != '\0') {
        const char *e = c;
        while (*e != '\0' && *e != '/') {
            e++;
        }
        size_t n = (size_t)(e - c);
        if (n == 0U && *e == '/') {
            return AEGIS_SPEC_E_PATH; /* "//" */
        }
        if ((n == 1U && c[0] == '.') || (n == 2U && c[0] == '.' && c[1] == '.')) {
            return AEGIS_SPEC_E_PATH;
        }
        c = (*e == '/') ? e + 1 : e;
        if (*e == '/' && *c == '\0') {
            return AEGIS_SPEC_E_PATH; /* trailing slash */
        }
    }
    return 0;
}

/* The cell's tree is the host's /usr and nothing else (Amendment 1): bind sources, targets and
 * masks must be /usr or below it. Defence in depth: the encoder already guarantees it. */
static int check_under_usr(const char *s)
{
    if (strncmp(s, "/usr", 4) != 0 || (s[4] != '\0' && s[4] != '/')) {
        return AEGIS_SPEC_E_PATH;
    }
    return 0;
}

static int parse_entry(const uint8_t *p, size_t len, aegis_root_entry_t *e)
{
    if (len < 5U) {
        return AEGIS_SPEC_E_ENTRY;
    }
    uint8_t kind = p[0];
    size_t src_len = rd16(p + 1);
    size_t tgt_len = rd16(p + 3);
    if (len != 5U + src_len + tgt_len) {
        return AEGIS_SPEC_E_ENTRY;
    }
    if (kind < AEGIS_ENTRY_BIND_DIR || kind > AEGIS_ENTRY_MKDIR) {
        return AEGIS_SPEC_E_ENTRY;
    }
    const char *src = NULL;
    const char *tgt = NULL;
    int rc = take_string(p + 5, src_len, &src);
    if (rc != 0) {
        return rc;
    }
    rc = take_string(p + 5U + src_len, tgt_len, &tgt);
    if (rc != 0) {
        return rc;
    }
    if (kind == AEGIS_ENTRY_MKDIR) {
        /* MKDIR carries only a target; the source is the empty string. */
        if (src[0] != '\0') {
            return AEGIS_SPEC_E_ENTRY;
        }
    } else if (kind == AEGIS_ENTRY_SYMLINK) {
        if (src[0] == '\0') {
            return AEGIS_SPEC_E_ENTRY;
        }
    } else {
        rc = check_abs_path(src);
        if (rc == 0) {
            rc = check_under_usr(src);
        }
        if (rc != 0) {
            return rc;
        }
    }
    rc = check_abs_path(tgt);
    if (rc == 0) {
        rc = check_under_usr(tgt);
    }
    if (rc != 0) {
        return rc;
    }
    e->kind = kind;
    e->src = src;
    e->tgt = tgt;
    return 0;
}

int aegis_spec_parse(const uint8_t *buf, size_t len, aegis_spec_t *out)
{
    memset(out, 0, sizeof *out);
    if (len < AEGIS_SPEC_HEADER_BYTES) {
        return AEGIS_SPEC_E_SHORT;
    }
    if (len > AEGIS_SPEC_MAX_BYTES) {
        return AEGIS_SPEC_E_LENGTH;
    }
    if (memcmp(buf, AEGIS_SPEC_MAGIC, 4) != 0) {
        return AEGIS_SPEC_E_MAGIC;
    }
    if (rd16(buf + 4) != AEGIS_SPEC_VERSION || rd16(buf + 6) != 0U) {
        return AEGIS_SPEC_E_VERSION;
    }
    if (rd32(buf + 8) != len) {
        return AEGIS_SPEC_E_LENGTH;
    }

    int have_root = 0;
    int have_host = 0;
    int have_rootsz = 0;
    int have_tmpsz = 0;
    int have_cgfd = 0;
    int have_wlower = 0;
    int have_wrw = 0;
    int have_require = 0;
    out->require_mask = AEGIS_REQ_DEFAULT;
    size_t off = AEGIS_SPEC_HEADER_BYTES;
    while (off < len) {
        if (len - off < 8U) {
            return AEGIS_SPEC_E_SHORT;
        }
        uint16_t key = rd16(buf + off);
        if (rd16(buf + off + 2) != 0U) {
            return AEGIS_SPEC_E_KEY;
        }
        size_t rlen = rd32(buf + off + 4);
        off += 8U;
        if (rlen > len - off) {
            return AEGIS_SPEC_E_SHORT;
        }
        const uint8_t *body = buf + off;
        off += rlen;
        const char *s = NULL;
        int rc;

        switch (key) {
        case AEGIS_KEY_ARGV:
            if (out->argc >= AEGIS_SPEC_MAX_ARGV) {
                return AEGIS_SPEC_E_LIMIT;
            }
            rc = take_string(body, rlen, &s);
            if (rc != 0) {
                return rc;
            }
            out->argv[out->argc++] = s;
            break;
        case AEGIS_KEY_ENV:
            if (out->envc >= AEGIS_SPEC_MAX_ENV) {
                return AEGIS_SPEC_E_LIMIT;
            }
            rc = take_string(body, rlen, &s);
            if (rc != 0) {
                return rc;
            }
            if (strchr(s, '=') == NULL || s[0] == '=') {
                return AEGIS_SPEC_E_STRING;
            }
            out->envp[out->envc++] = s;
            break;
        case AEGIS_KEY_ROOT_MOUNTPOINT:
            if (have_root) {
                return AEGIS_SPEC_E_DUPLICATE;
            }
            rc = take_string(body, rlen, &s);
            if (rc != 0) {
                return rc;
            }
            rc = check_abs_path(s);
            if (rc != 0) {
                return rc;
            }
            out->root_mountpoint = s;
            have_root = 1;
            break;
        case AEGIS_KEY_HOSTNAME:
            if (have_host) {
                return AEGIS_SPEC_E_DUPLICATE;
            }
            rc = take_string(body, rlen, &s);
            if (rc != 0) {
                return rc;
            }
            if (s[0] == '\0' || strlen(s) > 64U || strchr(s, '/') != NULL) {
                return AEGIS_SPEC_E_STRING;
            }
            out->hostname = s;
            have_host = 1;
            break;
        case AEGIS_KEY_ROOT_TMPFS_BYTES:
        case AEGIS_KEY_TMP_TMPFS_BYTES: {
            int *seen = (key == AEGIS_KEY_ROOT_TMPFS_BYTES) ? &have_rootsz : &have_tmpsz;
            if (*seen) {
                return AEGIS_SPEC_E_DUPLICATE;
            }
            if (rlen != 8U) {
                return AEGIS_SPEC_E_LIMIT;
            }
            uint64_t v = rd64(body);
            if (v < AEGIS_SPEC_MIN_TMPFS_BYTES || v > AEGIS_SPEC_MAX_TMPFS_BYTES) {
                return AEGIS_SPEC_E_LIMIT;
            }
            if (key == AEGIS_KEY_ROOT_TMPFS_BYTES) {
                out->root_tmpfs_bytes = v;
            } else {
                out->tmp_tmpfs_bytes = v;
            }
            *seen = 1;
            break;
        }
        case AEGIS_KEY_ROOT_ENTRY:
            if (out->nentries >= AEGIS_SPEC_MAX_ENTRIES) {
                return AEGIS_SPEC_E_LIMIT;
            }
            rc = parse_entry(body, rlen, &out->entries[out->nentries]);
            if (rc != 0) {
                return rc;
            }
            out->nentries++;
            break;
        case AEGIS_KEY_MASK_FILE:
        case AEGIS_KEY_MASK_DIR: {
            size_t *n = (key == AEGIS_KEY_MASK_FILE) ? &out->nmask_files : &out->nmask_dirs;
            if (*n >= AEGIS_SPEC_MAX_MASKS) {
                return AEGIS_SPEC_E_LIMIT;
            }
            rc = take_string(body, rlen, &s);
            if (rc != 0) {
                return rc;
            }
            rc = check_abs_path(s);
            if (rc == 0) {
                rc = check_under_usr(s);
            }
            if (rc != 0) {
                return rc;
            }
            if (key == AEGIS_KEY_MASK_FILE) {
                out->mask_files[(*n)++] = s;
            } else {
                out->mask_dirs[(*n)++] = s;
            }
            break;
        }
        case AEGIS_KEY_WORKSPACE_LOWER:
        case AEGIS_KEY_WORKSPACE_RW: {
            int *seen = key == AEGIS_KEY_WORKSPACE_LOWER ? &have_wlower : &have_wrw;
            if (*seen) {
                return AEGIS_SPEC_E_DUPLICATE;
            }
            rc = take_string(body, rlen, &s);
            if (rc != 0) {
                return rc;
            }
            rc = check_abs_path(s);
            if (rc != 0) {
                return rc;
            }
            if (key == AEGIS_KEY_WORKSPACE_LOWER) {
                out->workspace_lower = s;
            } else {
                out->workspace_rw = s;
            }
            *seen = 1;
            break;
        }
        case AEGIS_KEY_WORKSPACE_FORCE_COPY:
            if (rlen != 0U || out->workspace_force_copy) {
                return AEGIS_SPEC_E_LIMIT;
            }
            out->workspace_force_copy = 1;
            break;
        case AEGIS_KEY_REQUIRE_MASK:
            if (have_require) {
                return AEGIS_SPEC_E_DUPLICATE;
            }
            if (rlen != 4U) {
                return AEGIS_SPEC_E_LIMIT;
            }
            if ((rd32(body) & ~AEGIS_REQ_ALL) != 0U) {
                return AEGIS_SPEC_E_LIMIT; /* a layer this helper does not know */
            }
            out->require_mask = rd32(body);
            have_require = 1;
            break;
#ifdef AEGIS_ENABLE_ABLATION
        case AEGIS_KEY_ABLATE_MASK:
            if (out->ablate_mask != 0U || rlen != 4U) {
                return AEGIS_SPEC_E_LIMIT;
            }
            if ((rd32(body) & ~(AEGIS_REQ_ALL & ~(uint32_t)AEGIS_REQ_OVERLAY)) != 0U ||
                rd32(body) == 0U) {
                return AEGIS_SPEC_E_LIMIT;
            }
            out->ablate_mask = rd32(body);
            break;
#endif
        case AEGIS_KEY_CGROUP_FD:
            if (have_cgfd) {
                return AEGIS_SPEC_E_DUPLICATE;
            }
            if (rlen != 4U || rd32(body) != AEGIS_SPEC_CGROUP_FD) {
                return AEGIS_SPEC_E_LIMIT;
            }
            out->has_cgroup_fd = 1;
            have_cgfd = 1;
            break;
        default:
            return AEGIS_SPEC_E_KEY;
        }
    }

    if ((have_wlower != 0) != (have_wrw != 0)) {
        return AEGIS_SPEC_E_MISSING; /* workspace binds are all-or-nothing */
    }
    out->has_workspace = have_wlower;
    if (out->argc == 0U || !have_root || !have_host || !have_rootsz || !have_tmpsz) {
        return AEGIS_SPEC_E_MISSING;
    }
    if (out->argv[0][0] != '/') {
        return AEGIS_SPEC_E_PATH;
    }
    return 0;
}
