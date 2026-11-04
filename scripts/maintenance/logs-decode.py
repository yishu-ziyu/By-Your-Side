import json
import sys

from ccl_chromium_reader import ccl_chromium_indexeddb as idb

STORES = ("trace-sessions", "trace-lines", "voice-lines", "trace-prompts")


def plain(value):
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", "replace")
    if isinstance(value, dict):
        return {str(plain(k)): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def main():
    ldb, blob, out = sys.argv[1:4]
    db = idb.WrappedIndexDB(ldb, None if blob == "-" else blob)["sideagent-diagnostics"]
    names = set(db.object_store_names)
    with open(out, "w", encoding="utf-8", errors="replace") as f:
        for store in STORES:
            if store not in names:
                continue
            latest = {}
            for record in db[store].iterate_records():
                kept = latest.get(record.key.raw_key)
                if kept is None or record.ldb_seq_no > kept.ldb_seq_no:
                    latest[record.key.raw_key] = record
            for record in latest.values():
                if not record.is_live or record.value is None:
                    continue
                f.write(json.dumps({"store": store, "key": plain(record.key.value), "value": plain(record.value)}, ensure_ascii=False) + "\n")


main()
