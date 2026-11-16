import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from lease_guard import supervise,valid_lease

class LeaseGuardTests(unittest.TestCase):
    def test_expired_or_changed_token_never_starts_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease=Path(tmp)/'lease.json';lease.write_text(json.dumps({'token':'a','expiresAt':0}))
            output=Path(tmp)/'started'
            self.assertEqual(supervise([sys.executable,'-c',f'open({str(output)!r},"w").write("bad")'],lease,'a',.01),124)
            self.assertFalse(output.exists())
            self.assertFalse(valid_lease(lease,'other',now=-1))

    def test_expiration_stops_the_child_before_it_can_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease=Path(tmp)/'lease.json';lease.write_text(json.dumps({'token':'a','expiresAt':time.time()*1000+300}))
            result=Path(tmp)/'result'
            status=supervise([sys.executable,'-c',f'import time;time.sleep(3);open({str(result)!r},"w").write("stale")'],lease,'a',.02)
            self.assertEqual(status,124);self.assertFalse(result.exists())

    def test_valid_lease_allows_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease=Path(tmp)/'lease.json';lease.write_text(json.dumps({'token':'a','expiresAt':time.time()*1000+3000}))
            self.assertEqual(supervise([sys.executable,'-c','pass'],lease,'a',.01),0)

    def test_resume_after_sleep_uses_wall_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease=Path(tmp)/'lease.json';lease.write_text(json.dumps({'token':'a','expiresAt':1000}))
            self.assertTrue(valid_lease(lease,'a',now=999));self.assertFalse(valid_lease(lease,'a',now=1001))

if __name__=='__main__':unittest.main()
