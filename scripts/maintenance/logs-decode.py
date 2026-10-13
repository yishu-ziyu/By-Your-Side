# 由 logs.mjs 调用：读一份 IndexedDB 副本里的 sideagent-diagnostics 库，每条记录写成一行 {"store", "key", "value"}。
# 只读这一个库的三张表；不碰别的库。
#   python -I logs-decode.py <leveldb 副本> <blob 副本或 -> <输出 jsonl>
import json
import sys

from ccl_chromium_reader import ccl_chromium_indexeddb as idb

STORES = ("trace-sessions", "trace-lines", "voice-lines")


def plain(value):
    # 扩展写进去的是 JS 字符串，库有时按字节返回：按 UTF-8 解，坏字节换成替代符。
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
    # 字符串里可能有落单的代理码位（截断在一个字的中间），写出时换成替代符。
    with open(out, "w", encoding="utf-8", errors="replace") as f:
        for store in STORES:
            if store not in names:
                continue
            # 这个版本的 iterate_records 不管 live_only，会把同一主键的每个旧版本和删除标记都给出来。
            # 按主键只留序号最大的一版；那一版是删除（已清空、已轮换掉的会话），就整条不要。
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
