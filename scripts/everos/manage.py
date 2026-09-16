"""Enable, stop, or inspect daily collection without touching browser sessions."""
import argparse,json,os,re,subprocess,time
from pathlib import Path
LABEL='local.by-your-side.everos'
parser=argparse.ArgumentParser();parser.add_argument('action',choices=['on','off','status']);parser.add_argument('--root',type=Path,default=Path.home()/'.sideagent/everos');args=parser.parse_args()
root=args.root;path=root/'control.json';config=json.loads(path.read_text());target=f'gui/{os.getuid()}/{LABEL}'
def write():
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(config,indent=2));tmp.chmod(0o600);tmp.replace(path)
if args.action=='off':
    config['enabled']=False;write();subprocess.run(['launchctl','bootout',target],capture_output=True)
    # bootout can return before the domain entry disappears; do not race an immediate enable.
    deadline=time.time()+15
    while subprocess.run(['launchctl','print',target],capture_output=True).returncode==0:
        if time.time()>deadline:raise RuntimeError('Service is still stopping; retry status shortly')
        time.sleep(0.2)
if args.action=='on':
    if not config.get('enabled'):config['enabledSince']=int(time.time()*1000)
    config['enabled']=True;write()
    loaded=subprocess.run(['launchctl','print',target],capture_output=True).returncode==0
    command=['launchctl','kickstart',target] if loaded else ['launchctl','bootstrap',f'gui/{os.getuid()}',str(Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist')]
    subprocess.run(command,check=True,capture_output=True)
state=json.loads((root/'ingestion.json').read_text()) if (root/'ingestion.json').exists() else {}
status=subprocess.run(['launchctl','print',target],capture_output=True,text=True)
counts={}
for task in state.get('tasks',{}).values():counts[task['stage']]=counts.get(task['stage'],0)+1
print(json.dumps({'enabled':config['enabled'],'running':'state = running' in status.stdout,'port':config['port'],'mode':config['mode'],'tasks':counts,'heartbeatAt':state.get('heartbeatAt'),'memoryDirectory':str(root/'memory')},ensure_ascii=False,indent=2))
