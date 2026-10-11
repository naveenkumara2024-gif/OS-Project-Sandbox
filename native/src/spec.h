#ifndef AEGIS_SPEC_H
#define AEGIS_SPEC_H

#include <stddef.h>
#include <stdint.h>

/*
 * Launch-spec wire format (CLAUDE.md 4, 5.5). This parser is the helper's only untrusted-input
 * parser: hard size cap, a version field, unknown keys rejected, every string NUL-terminated inside
 * its record and free of other NUL bytes, every list bounded. It allocates nothing; the parsed
 * view points into the caller's buffer.
 *
 * Layout, little-endian:
 *   header  : "AEGS", u16 version, u16 reserved (0), u32 total_len (header included)
 *   records : u16 key, u16 reserved (0), u32 len, len bytes
 *
 * ROOT_ENTRY record body: u8 kind, u16 src_len, u16 tgt_len, src bytes, tgt bytes; both strings
 * include their terminating NUL in src_len / tgt_len.
 */

#define AEGIS_SPEC_MAGIC "AEGS"
#define AEGIS_SPEC_VERSION 1U
#define AEGIS_SPEC_HEADER_BYTES 12U
#define AEGIS_SPEC_MAX_BYTES 65536U
#define AEGIS_SPEC_MAX_STRING 4096U
#define AEGIS_SPEC_MAX_ARGV 64U
#define AEGIS_SPEC_MAX_ENV 64U
#define AEGIS_SPEC_MAX_ENTRIES 512U
#define AEGIS_SPEC_MAX_MASKS 32U

/* Descriptor numbers are fixed by the launch protocol (native/src/boot.h). */
#define AEGIS_SPEC_CGROUP_FD 6U

#define AEGIS_SPEC_MIN_TMPFS_BYTES (1ULL << 20)
#define AEGIS_SPEC_MAX_TMPFS_BYTES (1ULL << 30)

enum aegis_spec_key {
    AEGIS_KEY_ARGV = 1,
    AEGIS_KEY_ENV = 2,
    AEGIS_KEY_ROOT_MOUNTPOINT = 3,
    AEGIS_KEY_HOSTNAME = 4,
    AEGIS_KEY_ROOT_TMPFS_BYTES = 5,
    AEGIS_KEY_TMP_TMPFS_BYTES = 6,
    AEGIS_KEY_ROOT_ENTRY = 7,
    AEGIS_KEY_MASK_FILE = 8,
    AEGIS_KEY_MASK_DIR = 9,
    AEGIS_KEY_CGROUP_FD =
        10, /* u32, must be 6: a cgroup directory fd is passed for CLONE_INTO_CGROUP */
    AEGIS_KEY_WORKSPACE_LOWER = 11, /* host path: read-only bind, the ingested snapshot */
    /* host path: read-write bind. Must already contain "upper" and "work" subdirectories, both
     * reachable without crossing a mount boundary, which overlayfs requires of upperdir/workdir. */
    AEGIS_KEY_WORKSPACE_RW = 12,
    AEGIS_KEY_WORKSPACE_FORCE_COPY = 13 /* flag (empty body): skip the overlay attempt (tests) */
};

enum aegis_root_kind {
    AEGIS_ENTRY_BIND_DIR = 1,
    AEGIS_ENTRY_BIND_FILE = 2,
    AEGIS_ENTRY_SYMLINK = 3,
    AEGIS_ENTRY_MKDIR = 4
};

/* Negative return values of aegis_spec_parse. */
enum aegis_spec_error {
    AEGIS_SPEC_E_SHORT = -1,     /* shorter than the header or a record */
    AEGIS_SPEC_E_MAGIC = -2,     /* wrong magic */
    AEGIS_SPEC_E_VERSION = -3,   /* unsupported version or reserved field not zero */
    AEGIS_SPEC_E_LENGTH = -4,    /* header length does not match the buffer, or over the cap */
    AEGIS_SPEC_E_KEY = -5,       /* unknown key or non-zero record reserved field */
    AEGIS_SPEC_E_DUPLICATE = -6, /* singleton key repeated */
    AEGIS_SPEC_E_STRING = -7,    /* missing terminator, embedded NUL, or too long */
    AEGIS_SPEC_E_LIMIT = -8,     /* a list or numeric value is out of bounds */
    AEGIS_SPEC_E_PATH = -9,      /* path not absolute, or contains a ".." component */
    AEGIS_SPEC_E_MISSING = -10,  /* a required key is absent */
    AEGIS_SPEC_E_ENTRY = -11     /* malformed ROOT_ENTRY body or unknown kind */
};

typedef struct {
    uint8_t kind;
    const char *src; /* bind source, or symlink target */
    const char *tgt; /* path inside the new root, always absolute */
} aegis_root_entry_t;

typedef struct {
    const char *argv[AEGIS_SPEC_MAX_ARGV + 1U];
    size_t argc;
    const char *envp[AEGIS_SPEC_MAX_ENV + 1U];
    size_t envc;
    const char *root_mountpoint;
    const char *hostname;
    uint64_t root_tmpfs_bytes;
    uint64_t tmp_tmpfs_bytes;
    aegis_root_entry_t entries[AEGIS_SPEC_MAX_ENTRIES];
    size_t nentries;
    const char *mask_files[AEGIS_SPEC_MAX_MASKS];
    size_t nmask_files;
    const char *mask_dirs[AEGIS_SPEC_MAX_MASKS];
    size_t nmask_dirs;
    int has_cgroup_fd; /* the control plane passed a cgroup directory on descriptor 6 */
    const char *workspace_lower;
    const char *workspace_rw;
    int has_workspace; /* both of the above were present */
    int workspace_force_copy;
} aegis_spec_t;

/* Returns 0 on success or a negative enum aegis_spec_error value. */
int aegis_spec_parse(const uint8_t *buf, size_t len, aegis_spec_t *out);

#endif
