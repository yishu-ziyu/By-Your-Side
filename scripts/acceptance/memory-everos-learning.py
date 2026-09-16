"""Run EverOS's actual agent case/skill pipeline on three verified browser episodes.
No product integration. Explicit facts stay in the product store; profile inference is off.
"""
import json,os,re,subprocess,time
from pathlib import Path
base=Path('/tmp/bys-memory-eval-PBf7d2')
out=Path('docs/evals/20260916-memory-implementation/everos');out.mkdir(parents=True,exist_ok=True)
source=Path('docs/evals/20260916-memory-implementation/live-attempt2')
run=base/('agent-learning-'+str(int(time.time())));run.mkdir()
key=json.loads((Path.home()/'.pi/agent/auth.json').read_text())['opencode-go']['key']
report={'root':str(run),'source':str(source),'provider':'opencode-go/deepseek-flash','embedding':'BAAI/bge-small-zh-v1.5 local, zero-padded 512 to 1024 for EverOS schema; cosine unchanged','steps':[]}
process=None
try:
    process=subprocess.Popen([str(base/'mem0-venv/bin/python'),'scripts/acceptance/memory-embedding-server.py'],stdout=subprocess.PIPE,stderr=open(out/'embedding.log','w'),text=True)
    port=json.loads(process.stdout.readline())['port']
    os.environ.update({'EVEROS_ROOT':str(run),'EVEROS_LLM__API_KEY':key,'EVEROS_LLM__BASE_URL':'https://opencode.ai/zen/go/v1','EVEROS_LLM__MODEL':'deepseek-flash','EVEROS_LLM__TIMEOUT_SECONDS':'45','EVEROS_LLM__EXTRA':json.dumps({'extra_headers':{'x-opencode-session':'bys-everos-learning'}}),'EVEROS_MEMORIZE__MODE':'agent','EVEROS_EMBEDDING__API_KEY':'local-eval','EVEROS_EMBEDDING__BASE_URL':f'http://127.0.0.1:{port}/v1','EVEROS_EMBEDDING__MODEL':'BAAI/bge-small-zh-v1.5'})
    (run/'ome.toml').write_text('[strategies.extract_user_profile]\nenabled = false\n[strategies.reflect_episodes]\nenabled = false\n[strategies.extract_foresight]\nenabled = false\n')
    from fastapi.testclient import TestClient
    from everos.entrypoints.api.app import create_app
    from everos.service.memorize import _get_engine
    cases=json.loads((source/'cases.json').read_text())
    runtime=Path(json.loads((source/'result.json').read_text())['runtimeDir'])
    selected=[c for c in cases if '帮我报名' in c['text'] and c['result']=='报名成功']
    assert len(selected)==3, 'Need three verified authorized browser tasks'
    def save(): (out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2).replace(key,'[REDACTED]'))
    with TestClient(create_app()) as client:
        report['health']=client.get('/health').json()
        for index,c in enumerate(selected):
            path=next((runtime/'conversations'/c['cid']).glob('*.jsonl'))
            messages=[]
            for row in map(json.loads,path.read_text().splitlines()):
                m=row.get('message',{});role=m.get('role')
                if role not in ['user','assistant','toolResult']: continue
                role='tool' if role=='toolResult' else role
                parts=m.get('content',[])
                content='\n'.join(p.get('text','') for p in parts if p.get('type')=='text') if isinstance(parts,list) else str(parts)
                item={'role':role,'sender_id':'bys-browser' if role=='assistant' else 'synthetic-user' if role=='user' else 'browser-tools','timestamp':m.get('timestamp',int(time.time()*1000)),'content':content[:16000]}
                if role=='tool': item['tool_call_id']=m['toolCallId']
                calls=[{'id':p['id'],'type':'function','function':{'name':p['name'],'arguments':json.dumps(p['arguments'],ensure_ascii=False)}} for p in parts if isinstance(p,dict) and p.get('type')=='toolCall'] if isinstance(parts,list) else []
                if calls:item['tool_calls']=calls
                # Remove contact values, retaining the observed procedure and outcome.
                item=json.loads(re.sub(r'[\w.+-]+@example\.test','TASK_EMAIL',json.dumps(item,ensure_ascii=False)))
                messages.append(item)
            payload={'session_id':'browser-episode-'+str(index),'app_id':'bys-eval','project_id':'signup','defer_extraction':True,'messages':messages}
            (out/f'input-{index}.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2))
            started=time.time();added=client.post('/api/v2/memory/add',json=payload)
            flushed=client.post('/api/v2/memory/flush',json={k:payload[k] for k in ['session_id','app_id','project_id']})
            step={'episode':index,'add_status':added.status_code,'flush_status':flushed.status_code,'flush':flushed.json()};report['steps'].append(step);save()
            if flushed.status_code!=200: break
            step['background_idle']=client.portal.call(lambda:_get_engine().wait_idle(timeout=90.0))
            step['ms']=int((time.time()-started)*1000)
            step['case_files']=len(list(run.rglob('.cases/*.md')));step['skill_files']=len(list(run.rglob('SKILL.md')));save();print('EPISODE',index,step,flush=True)
        # Read back actual generated Markdown and actual native keyword retrieval.
        report['markdown']={str(p.relative_to(run)):p.read_text() for p in run.rglob('*.md')}
        for q in ['填写邮箱 报名 提交 验证','email registration form submit verify','比较雨伞和雨衣']:
            response=client.post('/api/v2/memory/search',json={'agent_id':'bys-browser','app_id':'bys-eval','project_id':'signup','query':q,'method':'keyword','top_k':5})
            report.setdefault('recall',[]).append({'query':q,'status':response.status_code,'response':response.json()})
        save()
except Exception as e:
    report['error']={'type':type(e).__name__,'message':str(e).replace(key,'[REDACTED]')[:1000]}
finally:
    (out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2).replace(key,'[REDACTED]'))
    if process:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
