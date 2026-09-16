"""Isolated local embedder for EverOS evaluation. No hosted embedding API or user data."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from fastembed import TextEmbedding
os.environ['FASTEMBED_CACHE_PATH']='/tmp/bys-memory-eval-PBf7d2/embedding-cache'
model=TextEmbedding('BAAI/bge-small-zh-v1.5')
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        texts=body['input']; texts=[texts] if isinstance(texts,str) else texts
        vectors=list(model.embed(texts))
        payload=json.dumps({'object':'list','model':'bge-small-zh-zero-padded-1024','data':[{'object':'embedding','index':i,'embedding':v.tolist()+[0.0]*512} for i,v in enumerate(vectors)],'usage':{'prompt_tokens':0,'total_tokens':0}}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
server=HTTPServer(('127.0.0.1',0),Handler)
print(json.dumps({'port':server.server_port}),flush=True)
server.serve_forever()
