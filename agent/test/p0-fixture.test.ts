import {afterEach,expect,it} from 'vitest';
import {createP0Fixture} from '../../scripts/eval/lib/p0-fixture.js';

const servers:ReturnType<typeof createP0Fixture>[]=[];

afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}});

async function fixture(){const server=createP0Fixture('abcd');servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();

if(!address||typeof address==='string')throw Error('fixture did not bind');

return `http://127.0.0.1:${address.port}`;}

it('serves distinct source pages without changing synthetic records',async()=>{const root=await fixture();expect(await fetch(root+'/offer/b').then(r=>r.text())).toContain('七天退换');expect(await fetch(root+'/api/state').then(r=>r.json())).toMatchObject({sideEffects:0,duplicateWrites:0,wrongPageWrites:0});});

it('records one write before truncating the receipt body so a deliberate retry is observable',async()=>{const root=await fixture();const post=(path:string,value:unknown)=>fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});await post('/api/fault',{dropNextReceipt:true});const input={name:'测试甲',choice:'b',page:'/form'};const lost=await post('/api/submit',input);expect(lost.ok).toBe(true);await expect(lost.json()).rejects.toThrow();expect(await fetch(root+'/api/state').then(r=>r.json())).toMatchObject({sideEffects:1,duplicateWrites:0});await post('/api/submit',input);expect(await fetch(root+'/api/state').then(r=>r.json())).toMatchObject({sideEffects:2,duplicateWrites:1});});

it('detects writes to the wrong page and allows an explicit synthetic account change',async()=>{const root=await fixture();const post=(path:string,value:unknown)=>fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});await post('/api/account',{account:'B'});await post('/api/submit',{name:'测试乙',choice:'c',page:'/other'});expect(await fetch(root+'/api/state').then(r=>r.json())).toMatchObject({account:'B',wrongPageWrites:1});});
