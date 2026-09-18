import {createP0Fixture} from '../eval/lib/p0-fixture.js';
const port=Number(process.env.P0_FIXTURE_PORT??0);
if(!Number.isInteger(port)||port<0||port>65535)throw new Error('P0_FIXTURE_PORT 无效');
const server=createP0Fixture();
server.listen(port,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')console.log(`P0 synthetic fixture: http://127.0.0.1:${address.port}/\n仅服务本机虚构数据；不会启动浏览器或模型。Ctrl-C 停止。`);});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>server.close(()=>process.exit(0)));
