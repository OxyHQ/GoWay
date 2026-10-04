import hashlib
import os
import time

from goway_reconstruction.storage import ContentCache, Ledger, Scratch


def test_cache_verifies_and_evicts(tmp_path):
    cache = ContentCache(tmp_path / "c", max_bytes=2500)
    shas = []
    for i in range(4):
        data = bytes([i]) * 1000
        src = tmp_path / f"s{i}"
        src.write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        cache.put(sha, src)
        shas.append(sha)
        time.sleep(0.01)
    assert cache.size() <= 2500
    assert cache.get(shas[0]) is None and cache.get(shas[-1]) is not None
    # a corrupted entry is a miss, never a hit
    path = cache.get(shas[-1])
    path.write_bytes(b"tampered")
    assert cache.get(shas[-1]) is None


def test_scratch_keeps_only_resume_and_diagnostics(tmp_path):
    scratch = Scratch(tmp_path / "w", keep_failed_hours=1)
    work = scratch.for_job("j1")
    (work / "images").mkdir()
    (work / "images" / "a.jpg").write_bytes(b"x" * 100)
    (work / "resume").mkdir()
    (work / "resume" / "train.ckpt").write_bytes(b"ckpt")
    scratch.keep_diagnostics("j1", {"code": "internal"})
    assert sorted(p.name for p in work.iterdir()) == ["diagnostics.json", "resume"]
    old = time.time() - 7200
    os.utime(work, (old, old))
    assert scratch.sweep() == 1 and not work.exists()


def test_ledger_recovers_interrupted_jobs(tmp_path):
    ledger = Ledger(tmp_path / "s.db")
    ledger.start("a", 1)
    ledger.start("b", 1)
    ledger.finish("b", "completed", ("jobs/b/attempt-1/result.json", "0" * 64, 10))
    reopened = Ledger(tmp_path / "s.db")
    assert reopened.interrupted() == ["a"]
    assert reopened.completed_result("b") == ("jobs/b/attempt-1/result.json", "0" * 64, 10)
    assert reopened.completed_result("a") is None
