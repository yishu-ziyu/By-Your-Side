"""Isolated hook regression tests; real CLI/event evidence is recorded in the eval."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]


class ConsolidationHookTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ego-wiki-hook-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.wiki = self.root / ".kimi-code/wiki"
        self.wiki.mkdir(parents=True)
        self.sessions = self.root / "sessions"
        wire = self.sessions / "wd/session_real/agents/main/wire.jsonl"
        wire.parent.mkdir(parents=True)
        wire.write_text('{}\n' * 60)
        self.wire = wire
        source = (ROOT / ".kimi-code/hooks/consolidate.sh").read_text()
        source = source.replace(str(ROOT), str(self.root))
        source = source.replace('$HOME/.kimi-code/sessions', str(self.sessions))
        self.hook = self.root / "hook.sh"
        self.hook.write_text(source)
        fake = self.root / "kimi"
        fake.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
Path("calls.jsonl").open("a").write(json.dumps(sys.argv[1:]) + "\\n")
assert sys.argv[1] == "--agent-file"
assert sys.argv[3] == "-p" and len(sys.argv) == 5
assert str(Path.cwd() / "sessions/wd/session_real/agents/main/wire.jsonl") in sys.argv[4]
assert "来源会话 id: session_real" in sys.argv[4]
assert os.environ.get("KIMI_CONSOLIDATE_CHILD") == "1"
sys.exit(7 if Path("fail").exists() else 0)
''')
        fake.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH']}
        self.env.pop('KIMI_CONSOLIDATE_CHILD', None)

    def run_hook(self, cwd=None, child=False):
        env = dict(self.env)
        if child:
            env['KIMI_CONSOLIDATE_CHILD'] = '1'
        subprocess.run(['bash', str(self.hook)], input=json.dumps({
            'cwd': str(self.root) if cwd is None else cwd,
            'session_id': 'session_real',
        }), text=True, env=env, check=True, timeout=3)

    def wait_finished(self, count=1):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            log = self.wiki / 'consolidate.log'
            if log.exists() and log.read_text().count('finished exit=') >= count:
                # The completion marker precedes failure lock release.
                if not (self.root / 'fail').exists():
                    return log.read_text()
                if (self.wiki / 'consolidate.lock').stat().st_mtime < time.time() - 600:
                    return log.read_text()
            time.sleep(.02)
        self.fail('background process did not finish/release failure cooldown')

    def test_other_workspace_and_recursion_do_not_launch(self):
        self.run_hook(cwd='/unrelated')
        self.run_hook(child=True)
        self.assertFalse((self.root / 'calls.jsonl').exists())
        self.assertFalse((self.wiki / 'consolidate.lock').exists())

    def test_short_trace_records_skip_without_launch(self):
        self.wire.write_text('{}\n' * 49)
        self.run_hook()
        self.assertIn('skipped=short-trace', (self.wiki / 'consolidate.log').read_text())
        self.assertFalse((self.root / 'calls.jsonl').exists())

    def test_cli_arguments_completion_and_duplicate(self):
        self.run_hook()
        self.assertIn('session=session_real finished exit=0', self.wait_finished())
        self.run_hook()
        self.assertEqual(len((self.root / 'calls.jsonl').read_text().splitlines()), 1)
        self.assertIn('skipped=cooldown', (self.wiki / 'consolidate.log').read_text())

    def test_failure_is_visible_and_retry_is_allowed(self):
        failure = self.root / 'fail'
        failure.touch()
        self.run_hook()
        self.assertIn('finished exit=7', self.wait_finished())
        failure.unlink()
        self.run_hook()
        self.assertIn('finished exit=0', self.wait_finished(2))
        self.assertEqual(len((self.root / 'calls.jsonl').read_text().splitlines()), 2)


if __name__ == '__main__':
    unittest.main()
