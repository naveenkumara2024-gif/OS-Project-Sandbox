/*
 * libFuzzer target for the launch-spec parser (CLAUDE.md 5.5, 7). Built only by
 * `node scripts/build-native.mjs fuzz --cc=clang`; it is never part of the helper.
 *
 * Beyond "does not crash", a successful parse must satisfy the invariants the boot code relies on:
 * every string pointer lies inside the input and is NUL-terminated there, counts are within their
 * caps, and argv[0] is absolute.
 */
#include "spec.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void must(int cond)
{
    if (!cond) {
        abort();
    }
}

static void check_str(const uint8_t *data, size_t size, const char *s)
{
    const uint8_t *p = (const uint8_t *)s;
    must(p >= data && p < data + size);
    must(memchr(p, 0, (size_t)(data + size - p)) != NULL);
}

/* True when some path component is exactly "..". A name that merely contains ".." (for example
 * "a..b") is a legal component, so a substring search would be a false positive. */
static int has_dotdot_component(const char *p)
{
    const char *c = p;
    while (*c != '\0') {
        const char *e = c;
        while (*e != '\0' && *e != '/') {
            e++;
        }
        if ((size_t)(e - c) == 2U && c[0] == '.' && c[1] == '.') {
            return 1;
        }
        c = (*e == '/') ? e + 1 : e;
    }
    return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    static aegis_spec_t spec;
    int rc = aegis_spec_parse(data, size, &spec);
    if (rc != 0) {
        must(rc < 0);
        return 0;
    }
    must(spec.argc >= 1U && spec.argc <= AEGIS_SPEC_MAX_ARGV);
    must(spec.envc <= AEGIS_SPEC_MAX_ENV);
    must(spec.nentries <= AEGIS_SPEC_MAX_ENTRIES);
    must(spec.nmask_files <= AEGIS_SPEC_MAX_MASKS && spec.nmask_dirs <= AEGIS_SPEC_MAX_MASKS);
    must(spec.argv[0][0] == '/');
    must(spec.has_cgroup_fd == 0 || spec.has_cgroup_fd == 1);
    must(spec.has_workspace == 0 || spec.has_workspace == 1);
    if (spec.has_workspace) {
        check_str(data, size, spec.workspace_lower);
        check_str(data, size, spec.workspace_rw);
        must(spec.workspace_lower[0] == '/' && spec.workspace_rw[0] == '/');
        must(!has_dotdot_component(spec.workspace_lower) &&
             !has_dotdot_component(spec.workspace_rw));
    } else {
        must(spec.workspace_lower == NULL && spec.workspace_rw == NULL);
    }
    must(spec.argv[spec.argc] == NULL && spec.envp[spec.envc] == NULL);
    for (size_t i = 0; i < spec.argc; i++) {
        check_str(data, size, spec.argv[i]);
    }
    for (size_t i = 0; i < spec.envc; i++) {
        check_str(data, size, spec.envp[i]);
        must(strchr(spec.envp[i], '=') != NULL);
    }
    check_str(data, size, spec.root_mountpoint);
    check_str(data, size, spec.hostname);
    must(spec.root_mountpoint[0] == '/' && !has_dotdot_component(spec.root_mountpoint));
    must(spec.root_tmpfs_bytes >= AEGIS_SPEC_MIN_TMPFS_BYTES &&
         spec.root_tmpfs_bytes <= AEGIS_SPEC_MAX_TMPFS_BYTES);
    must(spec.tmp_tmpfs_bytes >= AEGIS_SPEC_MIN_TMPFS_BYTES &&
         spec.tmp_tmpfs_bytes <= AEGIS_SPEC_MAX_TMPFS_BYTES);
    for (size_t i = 0; i < spec.nentries; i++) {
        check_str(data, size, spec.entries[i].src);
        check_str(data, size, spec.entries[i].tgt);
        must(spec.entries[i].tgt[0] == '/' && !has_dotdot_component(spec.entries[i].tgt));
        must(spec.entries[i].kind >= AEGIS_ENTRY_BIND_DIR &&
             spec.entries[i].kind <= AEGIS_ENTRY_MKDIR);
    }
    return 0;
}
