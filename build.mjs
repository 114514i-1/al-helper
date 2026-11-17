import {relative,join,sep} from 'node:path';
import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
const read = path => readFile(path,'utf8');
const files = {};
const types = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',webp:'image/webp',png:'image/png',svg:'image/svg+xml',jpg:'image/jpeg'};
for (const item of await readdir('public',{recursive:true,withFileTypes:true})) {
  if(!item.isFile()) continue;
  const name = relative('public',join(item.parentPath,item.name)).split(sep).join('/');
  const ext = name.split('.').at(-1);
  files['/'+name] = [types[ext],(await readFile('public/'+name)).toString('base64')];
}
files['/desk.webp'] = ['image/webp',(await read('desk.webp.b64')).trim()];
const seed = (await read('public/seed.js')).replace('export default','return');
const api = (await read('worker.js')).replace(/^import .*;\r?$/gm,'').replace('export default','const api =');
const entry = `const seed=(()=>{${seed}})();\n\n${api}\nconst resources=${JSON.stringify(files)};
export default {async fetch(request,env) {
  const path = new URL(request.url).pathname;
  if(path.startsWith('/api/')) return api.fetch(request,env);
  const asset = resources[path==='/'?'/index.html':(/^\\/admin\\/?$/.test(path)?'/admin.html':path)];
  if(!asset) return new Response('页面不存在',{status:404});
  return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(asset[1]),c=>c.charCodeAt(0)),{headers:{'Content-Type':asset[0],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'}});
}};`;
await mkdir('dist/server',{recursive:true});
await writeFile('dist/server/index.js',entry);
