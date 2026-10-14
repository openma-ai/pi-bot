import contextlib
import csv
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from workqueue.store import Queue

class Contract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, 'queue.sqlite')
        self.q = Queue(self.path)
    def tearDown(self):
        if hasattr(self, 'q'): self.q.close()
        self.temp.cleanup()
    def add(self, id='a', owner='alice', dependencies=None):
        self.q.add(id, 'Task '+id, owner, dependencies)
    def test_01_persistence(self):
        self.add(); self.q.close(); self.q=Queue(self.path)
        self.assertEqual(self.q.get('a')['status'], 'pending')
    def test_02_duplicate_atomic(self):
        self.add()
        with self.assertRaises((ValueError, KeyError)): self.add()
        self.assertEqual(len(self.q.list()), 1); self.assertEqual(len(self.q.events('a')),1)
    def test_03_unknown_dependency_atomic(self):
        with self.assertRaises((ValueError, KeyError)): self.add('a', dependencies=['missing'])
        self.assertEqual(self.q.list(),[])
        self.add(); self.assertEqual(self.q.get('a')['status'],'pending')
    def test_04_blocked_dependency(self):
        self.add(); self.add('b',dependencies=['a'])
        with self.assertRaises((ValueError,KeyError)): self.q.start('b')
        self.assertEqual(self.q.get('b')['status'],'pending')
    def test_05_dependency_unlock(self):
        self.add(); self.add('b',dependencies=['a']); self.q.start('a'); self.q.complete('a'); self.q.start('b')
        self.assertEqual(self.q.get('b')['status'],'running')
    def test_06_complete_idempotent(self):
        self.add(); self.q.start('a'); self.assertTrue(self.q.complete('a')); self.assertFalse(self.q.complete('a'))
        self.assertEqual([e['action'] for e in self.q.events('a')],['add','start','complete'])
    def test_07_cancel_idempotent(self):
        self.add(); self.assertTrue(self.q.cancel('a')); self.assertFalse(self.q.cancel('a'))
        self.assertEqual([e['action'] for e in self.q.events('a')],['add','cancel'])
    def test_08_cancel_running(self):
        self.add(); self.q.start('a'); self.q.cancel('a')
        with self.assertRaises((ValueError,KeyError)): self.q.complete('a')
    def test_09_done_cannot_cancel(self):
        self.add(); self.q.start('a'); self.q.complete('a')
        with self.assertRaises((ValueError,KeyError)): self.q.cancel('a')
    def test_10_pending_cannot_complete(self):
        self.add()
        with self.assertRaises((ValueError,KeyError)): self.q.complete('a')
    def test_11_atomic_batch_rollback(self):
        self.add(); self.add('b'); self.q.start('a')
        with self.assertRaises((ValueError,KeyError)): self.q.complete_many(['a','b'])
        self.assertEqual(self.q.get('a')['status'],'running'); self.assertEqual(len(self.q.events('a')),2)
    def test_12_atomic_batch_success(self):
        self.add(); self.add('b'); self.q.start('a'); self.q.start('b'); self.q.complete_many(['a','b'])
        self.assertTrue(all(t['status']=='done' for t in self.q.list()))
    def test_13_unknown_task(self):
        with self.assertRaises(KeyError): self.q.get('missing')
    def test_14_filters_sort(self):
        self.add('z','bob'); self.add('a'); self.add('c'); self.q.start('a')
        self.assertEqual([t['id'] for t in self.q.list()],['a','c','z'])
        self.assertEqual([t['id'] for t in self.q.list(owner='alice',status='pending')],['c'])
    def test_15_sql_parameterization(self):
        self.add("a'; DROP TABLE tasks;--")
        self.assertEqual(len(self.q.list()),1)
    def test_16_multiple_connections(self):
        other=Queue(self.path)
        try:
            self.add(); self.assertEqual(other.get('a')['status'],'pending')
            other.start('a'); self.assertEqual(self.q.get('a')['status'],'running')
        finally: other.close()
    def test_17_empty_fields(self):
        for values in [('', 't', 'a'), ('a','','a'), ('a','t','')]:
            with self.assertRaises((ValueError,KeyError)): self.q.add(*values)
        self.assertEqual(self.q.list(),[])
    def test_18_duplicate_dependency(self):
        self.add()
        with self.assertRaises((ValueError,KeyError)): self.add('b',dependencies=['a','a'])
        with self.assertRaises(KeyError): self.q.get('b')
    def test_19_migration_preserves(self):
        self.q.close(); os.remove(self.path)
        con=sqlite3.connect(self.path); con.executescript("CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT);INSERT INTO tasks VALUES('legacy','old','done');PRAGMA user_version=1;"); con.close()
        self.q=Queue(self.path); self.assertEqual(self.q.get('legacy')['owner'],'unknown'); self.assertEqual(self.q.get('legacy')['status'],'done')
        self.add('new'); self.assertEqual(len(self.q.list()),2)
        con=sqlite3.connect(self.path); self.assertEqual(con.execute('PRAGMA user_version').fetchone()[0],2); con.close()
    def test_20_events_reopen(self):
        self.add(); self.q.start('a'); self.q.close(); self.q=Queue(self.path)
        self.assertEqual([e['action'] for e in self.q.events('a')],['add','start'])
    def cli(self,*args):
        return subprocess.run([sys.executable,'-m','workqueue.cli','--db',self.path,*args],capture_output=True,text=True,timeout=10)
    def test_21_cli_add_list(self):
        r=self.cli('add','x','--title','CLI task','--owner','bob'); self.assertEqual(r.returncode,0,r.stderr)
        r=self.cli('list','--owner','bob'); self.assertEqual(r.returncode,0,r.stderr); self.assertEqual(json.loads(r.stdout)[0]['id'],'x')
    def test_22_cli_lifecycle(self):
        self.add()
        for command in ['start','complete']:
            r=self.cli(command,'a'); self.assertEqual(r.returncode,0,r.stderr); self.assertIsInstance(json.loads(r.stdout),dict)
        self.assertEqual(self.q.get('a')['status'],'done')
    def test_23_cli_dependency_error(self):
        self.add(); self.add('b',dependencies=['a']); r=self.cli('start','b')
        self.assertNotEqual(r.returncode,0); self.assertTrue(r.stderr.strip()); self.assertNotIn('Traceback',r.stderr); self.assertEqual(self.q.get('b')['status'],'pending')
    def test_24_cli_csv(self):
        self.add(); self.add('b'); self.add('c','bob'); self.q.start('a'); self.q.complete('a')
        r=self.cli('export','--format','csv'); self.assertEqual(r.returncode,0,r.stderr)
        rows=list(csv.DictReader(io.StringIO(r.stdout)))
        self.assertEqual(rows,[{'owner':'alice','total':'2','done':'1','completion_rate':'0.500000'},{'owner':'bob','total':'1','done':'0','completion_rate':'0.000000'}])
    def test_25_cli_help(self):
        r=self.cli('--help'); self.assertEqual(r.returncode,0,r.stderr); self.assertIn('export',r.stdout)
    def test_26_cli_cancel(self):
        self.add(); r=self.cli('cancel','a'); self.assertEqual(r.returncode,0,r.stderr); self.assertEqual(self.q.get('a')['status'],'cancelled')

if __name__=='__main__': unittest.main()
