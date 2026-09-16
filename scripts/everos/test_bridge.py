import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('bridge',Path(__file__).with_name('bridge.py'));bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)

def record(id='task1',start=101):
    return {'id':id,'startedAt':start,'endedAt':start+10,'goal':'导出所有客户','hostname':'example.test','outcome':'unknown','observations':[{'tool':'snapshot','failed':False,'text':'总计 42 条；token=secret-value'}],'feedback':['不对，我要全部']}

class PayloadTests(unittest.TestCase):
    def test_unknown_is_not_success_and_secret_is_redacted(self):
        data=bridge.task_payload(record());text=json.dumps(data,ensure_ascii=False)
        self.assertIn('unknown',text);self.assertNotIn('secret-value',text);self.assertNotIn('tool_calls',text)
        self.assertEqual(data['app_id'],'by-your-side');self.assertEqual(data['messages'][-1]['role'],'user')
    def test_sensitive_goal_and_empty_tasks_not_exported(self):
        r=record();r['goal']='帮我填写密码';self.assertIsNone(bridge.task_payload(r))
        r=record();r['observations']=[];self.assertIsNone(bridge.task_payload(r))
        r=record();r['observations'][0]['text']='Password input: unlabelled-private-value';self.assertIsNone(bridge.task_payload(r))
    def test_bad_identity_rejected(self):
        with self.assertRaises(ValueError):bridge.task_payload(record('../other'))
    def test_site_partition(self):
        r=record();a=bridge.task_payload(r);r['hostname']='other.test';b=bridge.task_payload(r)
        self.assertNotEqual(a['project_id'],b['project_id'])

class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_upload_or_uncertain_marker_before_service_is_ready(self):
        import httpx
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'experiences';source.mkdir()
            bridge.atomic_json(root/'control.json',{'enabled':True,'enabledSince':100})
            bridge.atomic_json(source/'task1.json',record())
            calls=[]
            class Client:
                def __init__(self,*args,**kwargs):pass
                async def __aenter__(self):return self
                async def __aexit__(self,*args):pass
                async def get(self,path):raise httpx.ConnectError('not bound yet')
                async def post(self,*args,**kwargs):calls.append('unexpected')
            with patch('httpx.AsyncClient',Client):
                worker=asyncio.create_task(bridge.collect(root,source,1234,0.01));await asyncio.sleep(0.03);worker.cancel()
                with self.assertRaises(asyncio.CancelledError):await worker
            self.assertEqual(calls,[]);self.assertFalse((root/'ingestion.json').exists())
    async def test_new_only_processed_not_replayed_and_pending_flush_resumes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'experiences';source.mkdir()
            bridge.atomic_json(root/'control.json',{'enabled':True,'enabledSince':100})
            for r in [record('old',1),record('new'),record('resume')]:bridge.atomic_json(source/(r['id']+'.json'),r)
            bridge.atomic_json(root/'ingestion.json',{'tasks':{'resume':{'stage':'buffered','attempts':0}}})
            calls=[]
            class Response:
                def raise_for_status(self):pass
                def json(self):return {'data':{'status':'extracted'}}
            class Client:
                def __init__(self,*args,**kwargs):pass
                async def __aenter__(self):return self
                async def __aexit__(self,*args):pass
                async def get(self,path):return Response()
                async def post(self,path,json):calls.append((path,json['session_id']));return Response()
            with patch('httpx.AsyncClient',Client):
                worker=asyncio.create_task(bridge.collect(root,source,1234,0.01))
                await asyncio.sleep(0.06);worker.cancel()
                with self.assertRaises(asyncio.CancelledError):await worker
            self.assertEqual(calls.count(('/api/v2/memory/add','bys-new')),1)
            self.assertNotIn(('/api/v2/memory/add','bys-resume'),calls)
            self.assertFalse(any(s=='bys-old' for _,s in calls))
            self.assertEqual(json.loads((root/'ingestion.json').read_text())['tasks']['new']['stage'],'processed')
    async def test_uncertain_add_is_not_blindly_resubmitted(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'experiences';source.mkdir()
            bridge.atomic_json(root/'control.json',{'enabled':True,'enabledSince':100})
            bridge.atomic_json(source/'task1.json',record())
            calls=[]
            class Client:
                def __init__(self,*args,**kwargs):pass
                async def __aenter__(self):return self
                async def __aexit__(self,*args):pass
                async def get(self,path):
                    class Health:
                        def raise_for_status(self):pass
                    return Health()
                async def post(self,path,json):calls.append(path);raise TimeoutError('provider unavailable')
            with patch('httpx.AsyncClient',Client):
                worker=asyncio.create_task(bridge.collect(root,source,1234,0.01));await asyncio.sleep(0.05);worker.cancel()
                with self.assertRaises(asyncio.CancelledError):await worker
            self.assertEqual(calls,['/api/v2/memory/add'])
            task=json.loads((root/'ingestion.json').read_text())['tasks']['task1']
            self.assertEqual(task['stage'],'adding');self.assertEqual(task['error'],'TimeoutError')

if __name__=='__main__':unittest.main()
