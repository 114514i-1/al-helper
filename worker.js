import seed from './public/seed.js';


const schema = [
  'CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS tutorials (id TEXT PRIMARY KEY, draft TEXT NOT NULL, published TEXT, trashed INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS revisions (article_id TEXT NOT NULL, revision INTEGER NOT NULL, at TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(article_id,revision))',
  'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, at TEXT NOT NULL, articleId TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, location TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,part))'
];
const initialized = new WeakMap();
const encode = JSON.stringify;
const decode = JSON.parse;
const now = () => new Date().toISOString();
const statement = (db, sql, ...args) => args.length ? db.prepare(sql).bind(...args) : db.prepare(sql);
const rows = async (db, sql, ...args) => (await statement(db, sql, ...args).all()).results;
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2,'0')).join('');
const fromHex = value => Uint8Array.from(value.match(/../g), x => parseInt(x,16));
const hash = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const json = (body,status=200,headers={}) => new Response(encode(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
function fail(status, message) { throw Object.assign(new Error(message), {status}); }
async function initialize(db) {
  if (!initialized.has(db)) {
    const ready = (async () => {
      await db.batch(schema.map(sql => db.prepare(sql)));
      const existing = await db.prepare("SELECT key FROM site_config WHERE key='initialized'").first();
      if (existing) return;
      const defaults = ['settings','categories','route'].map(k => statement(db,'INSERT OR IGNORE INTO site_config VALUES (?,?)', k, encode(seed[k])));
      for (const {id,...content} of seed.articles) {
        defaults.push(statement(db,'INSERT OR IGNORE INTO tutorials(id,draft,published,revision) VALUES (?,?,?,1)', id,encode(content),encode(content)));
        defaults.push(statement(db,'INSERT OR IGNORE INTO revisions VALUES (?,1,?,?)',id, content.updated || now(), encode(content)));
      }
      defaults.push(db.prepare("INSERT OR IGNORE INTO site_config VALUES ('initialized','true')"));
      await db.batch(defaults);
    })().catch(error => { initialized.delete(db); throw error; });
    initialized.set(db,ready);
  }
  await initialized.get(db);
}

async function readBody(request,max=600000) {
  const input = await request.text();
  if(input.length>max) fail(413,'内容太大，请缩小图片或拆分教程。');
  try {
    const obj = decode(input);
    if(!obj || typeof obj!=='object' || Array.isArray(obj)) throw new Error();
    return obj;
  } catch { fail(400,'请发送有效的表单内容。'); }
}
function trim(value,max=1200) { return typeof value==='string' ? value.trim().slice(0,max) : ''; }
async function limit(db, request, name, maximum, span) {
  const key = name+'-'+await hash(request.headers.get('cf-connecting-ip') || 'local');
  const time = Date.now();
  const counter = await statement(db,'INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count',key,time+span,time,time).first();
  if(counter.count>maximum) fail(429,'操作过于频繁，请稍后重试。');
}
async function validPassword(password, env) {
  const bytes = new TextEncoder().encode(password);
  if(env.ADMIN_PASSWORD) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_PASSWORD),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
    const sig = await crypto.subtle.sign('HMAC',k,new TextEncoder().encode('admin-login'));
    const probe = await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['verify']);
    return crypto.subtle.verify('HMAC',probe,sig,new TextEncoder().encode('admin-login'));
  }
  return false;
}
function cookie(request,token,seconds) {
  return 'al_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+seconds+(new URL(request.url).protocol==='https:'?'; Secure':'');
}
const getToken = request => (request.headers.get('Cookie')||'').match(/(?:^|;\s*)al_session=([0-9a-f]{64})(?:;|$)/)?.[1] || '';
async function config(db) {
  return Object.fromEntries((await rows(db,"SELECT key,data FROM site_config WHERE key IN ('settings','categories','route')")).map(r=>[r.key,decode(r.data)]));
}
async function publicData(db) {
  const configuration=await config(db);
  const articles=(await rows(db,'SELECT id,published,revision FROM tutorials WHERE published IS NOT NULL AND trashed=0 AND archived=0')).map(r=>({...decode(r.published),id:r.id,revision:r.revision}));
  return {...configuration,categories:configuration.categories.filter(c=>!c.hidden),articles};
}
async function adminData(db) {
  const configuration=await config(db);
  const [records,versions,media,feedback]=await Promise.all([
    rows(db,'SELECT * FROM tutorials ORDER BY rowid DESC'),
    rows(db,'SELECT * FROM revisions ORDER BY revision DESC'),
    rows(db,'SELECT id,name,mime FROM media ORDER BY rowid DESC'),
    rows(db,'SELECT * FROM feedback ORDER BY rowid DESC')
  ]);
  const history=new Map();
  for (const record of versions) {
    if(!history.has(record.article_id)) history.set(record.article_id,[]);
    history.get(record.article_id).push({at:record.at,revision:record.revision,content:decode(record.content)});
  }
  const templates=(await rows(db,"SELECT data FROM site_config WHERE key LIKE 'template:%' ORDER BY rowid")).map(r=>decode(r.data));
  return {...configuration,templates,articles:records.map(r=>({...r,draft:decode(r.draft),published:decode(r.published),trashed:!!r.trashed,archived:!!r.archived,history:history.get(r.id)||[]})),media:media.map(m=>({...m,url:'/api/media/'+m.id})),feedback};
}
async function editArticle(db, body) {
  const {action,content}=body;
  const id=trim(body.id,128)||crypto.randomUUID();
  if (!/^[\w-]+$/.test(id)) fail(400,'教程编号格式错误。');
  const record=await statement(db,'SELECT id FROM tutorials WHERE id=?',id).first();
  if (!record && ['trash','archive','restore'].includes(action)) fail(404,'教程不存在。');
  if(action==='trash' || action==='restore' || action==='archive') {
    const commands={trash:'trashed=1',restore:'trashed=0, archived=0',archive:'archived=1'};
    await statement(db,'UPDATE tutorials SET '+commands[action]+' WHERE id=?',id).run();
  } else {
    if (!['save','publish'].includes(action) || !content || typeof content!=='object' || Array.isArray(content)) fail(400,'缺少教程内容。');
    if(action==='publish' && !trim(content.title)) fail(400,'请先填写教程标题。');
    if(content.blocks!=null && !Array.isArray(content.blocks)) fail(400,'图文内容格式错误。');
    const draft={...content};
    delete draft.id;
    delete draft.revision;
    if(action==='publish') {
      draft.updated = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const data=encode(draft);
      await db.batch([
        statement(db,'INSERT INTO tutorials(id,draft,published,revision) VALUES (?,?,?,1) ON CONFLICT(id) DO UPDATE SET draft=excluded.draft,published=excluded.published,revision=tutorials.revision+1,trashed=0,archived=0',id,data,data),
        statement(db,'INSERT INTO revisions SELECT id,revision,?,published FROM tutorials WHERE id=?',now(),id)
      ]);
    } else await statement(db,'INSERT INTO tutorials(id,draft) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET draft=excluded.draft',id,encode(draft)).run();
  }
  return json({id});
}
async function editConfig(db,body) {
  const save=[];
  for (const key of ['categories','route','settings']) {
    if(!(key in body)) continue;
    if(key==='settings' ? (!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings)) : !Array.isArray(body[key])) fail(400,'设置格式无效。');
    save.push(statement(db,'INSERT OR REPLACE INTO site_config VALUES (?,?)',key,encode(body[key])));
  }
  if(save.length) await db.batch(save);
  return json({ok:true});
}
const contentTypes=['image/png','image/jpeg','image/webp','image/gif'];
function imageType(bytes) {
  const signature=hex(bytes.slice(0,8));
  if(signature==='89504e470d0a1a0a') return contentTypes[0];
  if(signature.startsWith('ffd8ff')) return contentTypes[1];
  if(signature.startsWith('52494646') && hex(bytes.slice(8,12))==='57454250') return contentTypes[2];
  if(signature.startsWith('474946383761')||signature.startsWith('474946383961')) return contentTypes[3];
  fail(400,'请选择 PNG、JPG、WebP 或 GIF 图片。');
}
function toBase64(bytes) {
  let result='';
  for(let i=0;i<bytes.length;i+=32768) result+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(result);
}
async function upload(env,body) {
  const match = typeof body.data==='string' && /^data:image\/(?:jpeg|png|gif|webp);base64,([\w+/=]+)$/i.exec(body.data);
  if(!match) fail(400,'请选择 PNG、JPG、WebP 或 GIF 图片。');
  let bytes;
  try { bytes=Uint8Array.from(atob(match[1]),c=>c.charCodeAt(0)); } catch { fail(400,'图片内容损坏。'); }
  if(bytes.length>8*1024*1024) fail(413,'请使用 8 MB 以内的图片。');
  const mime=imageType(bytes), id=crypto.randomUUID(), name=trim(body.name,240)||'教程图片';
  const register=statement(env.DB,'INSERT INTO media VALUES (?,?,?,?)',id,name,mime,env.BUCKET?'r2':'db');
  if(env.BUCKET) {
    await env.BUCKET.put(id,bytes,{httpMetadata:{contentType:mime}});
    try {await register.run();} catch(error){await env.BUCKET.delete(id); throw error;}
  } else {
    const chunks=[register];
    const base64=match[1];
    for(let i=0;i<base64.length;i+=240000) chunks.push(statement(env.DB,'INSERT INTO media_chunks VALUES (?,?,?)',id,i,base64.slice(i,i+240000)));
    await env.DB.batch(chunks);
  }
  return json({id,name,url:'/api/media/'+id});
}
async function uploadVideo(request,env) {
  const limit=64*1024*1024;
  const size=Number(request.headers.get('Content-Length'));
  const mime=request.headers.get('Content-Type')?.split(';')[0];
  if(!['video/mp4','video/webm'].includes(mime))fail(415,'请选择 MP4 或 WebM 视频。');
  if(!size||size>limit)fail(413,'视频须在 64 MB 以内。');
  const id=crypto.randomUUID(),name=trim(new URL(request.url).searchParams.get('name'),240)||'教程视频';
  const reader=request.body.getReader(),first=await reader.read();
  const sig=first.value||new Uint8Array();
  if(mime==='video/mp4'?String.fromCharCode(...sig.slice(4,8))!=='ftyp':hex(sig.slice(0,4))!=='1a45dfa3')fail(415,'文件与视频格式不匹配。');
  let prefix=sig;
  const stream=new ReadableStream({async pull(c){if(prefix){c.enqueue(prefix);prefix=null;return}const part=await reader.read();if(part.done)c.close();else c.enqueue(part.value)},cancel(){return reader.cancel()}});
  try {
    if(env.BUCKET){
      const fixed=new FixedLengthStream(size);
      await Promise.all([stream.pipeTo(fixed.writable),env.BUCKET.put(id,fixed.readable,{httpMetadata:{contentType:mime}})]);
    }else{
      const bytes=new Uint8Array(await new Response(stream).arrayBuffer());let part=0;
      for(let i=0;i<bytes.length;i+=90000)await statement(env.DB,'INSERT INTO media_chunks VALUES (?,?,?)',id,part++,toBase64(bytes.subarray(i,i+90000))).run();
    }
    await statement(env.DB,'INSERT INTO media VALUES (?,?,?,?)',id,name,mime,env.BUCKET?'r2':'db').run();
  }catch(e){if(env.BUCKET)await env.BUCKET.delete(id);else await statement(env.DB,'DELETE FROM media_chunks WHERE id=?',id).run();throw e}
  return json({id,name,mime,url:'/api/media/'+id});
}
function byteRange(header,size){
  if(!header)return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!m||(!m[1]&&!m[2]))return false;
  const start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));
  const end=m[1]&&m[2]?Math.min(Number(m[2]),size-1):size-1;
  return start<=end&&start<size?{offset:start,length:end-start+1}:false;
}
async function getMedia(env,id,rangeHeader) {
  const info=await statement(env.DB,'SELECT * FROM media WHERE id=?',id).first();
  if(!info)fail(404,'素材不存在。');
  const headers={'Content-Type':info.mime,'Accept-Ranges':'bytes','Cache-Control':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff'};
  let body,size,range;
  if(info.location==='r2'){
    const meta=await env.BUCKET.head(id);if(!meta)fail(404,'素材不存在。');
    size=meta.size;range=byteRange(rangeHeader,size);
    if(range!==false)body=(await env.BUCKET.get(id,range?{range}:{})).body;
  }else{
    const parts=await rows(env.DB,'SELECT data FROM media_chunks WHERE id=? ORDER BY part',id);
    const bytes=Uint8Array.from(atob(parts.map(r=>r.data).join('')),c=>c.charCodeAt(0));
    size=bytes.length;range=byteRange(rangeHeader,size);
    if(range!==false)body=range?bytes.subarray(range.offset,range.offset+range.length):bytes;
  }
  if(range===false)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
  headers['Content-Length']=String(range?.length??size);
  if(range)headers['Content-Range']='bytes '+range.offset+'-'+(range.offset+range.length-1)+'/'+size;
  return new Response(body,{status:range?206:200,headers});
}

function backup(env,data) {
  const encoder=new TextEncoder();
  const {media,...records}=data;
  async function* chunks(){
    yield encode({format:1,exportedAt:now(),...records}).slice(0,-1)+',"media":[';
    for(const [i,item] of media.entries()){
      const response=await getMedia(env,item.id);
      yield (i?',':'')+encode(item).slice(0,-1)+',"data":"data:'+response.headers.get('Content-Type')+';base64,';
      const reader=response.body.getReader();let tail=new Uint8Array();
      while(true){const {value,done}=await reader.read();if(done)break;
        const bytes=new Uint8Array(tail.length+value.length);bytes.set(tail);bytes.set(value,tail.length);
        const n=bytes.length-bytes.length%3;yield toBase64(bytes.subarray(0,n));tail=bytes.slice(n);
      }
      yield toBase64(tail)+'"}';
    }
    yield ']}';
  }
  const iterator=chunks();
  const stream=new ReadableStream({async pull(c){const result=await iterator.next();if(result.done)c.close();else c.enqueue(encoder.encode(result.value))},cancel(){return iterator.return()}});
  return new Response(stream,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Content-Disposition':'attachment; filename="al-helper-'+now().slice(0,10)+'.json"'}});
}
async function dispatch(request,env) {
  const url=new URL(request.url), path=url.pathname, method=request.method, db=env.DB;
  if(!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found',{status:404});
  if(!db) fail(503,'站点数据库尚未连接。');
  if(method!=='GET' && method!=='POST') fail(405,'不支持此操作。');
  if(method==='POST') {
    const origin=request.headers.get('Origin');
    if(origin && origin!==url.origin) fail(403,'请从本站提交。');
    if(!request.headers.get('Content-Type')?.includes('application/json') && path!=='/api/logout' && path!=='/api/admin/video') fail(415,'请提交 JSON 格式内容。');
  }
  await initialize(db);
  if(path==='/api/public' && method==='GET') return json(await publicData(db));
  if(path.startsWith('/api/article/') && method==='GET') {
    const r=await statement(db,'SELECT published,revision,archived,trashed,id FROM tutorials WHERE id=?',decodeURIComponent(path.slice(13))).first();
    if(!r?.published) fail(404,'找不到这篇教程。');
    if(r.trashed || r.archived) fail(410,'这篇教程已下架。');
    return json({...decode(r.published),id:r.id,revision:r.revision});
  }
  if(path.startsWith('/api/media/') && method==='GET') return getMedia(env,path.slice(11),request.headers.get('Range'));
  if(path==='/api/feedback' && method==='POST') {
    const body=await readBody(request,8000), type=trim(body.type,100), text=trim(body.text,2400);
    if(!type && !text) fail(400,'请选择反馈类型或填写建议。');
    await limit(db,request,'feedback',30,600000);
    await statement(db,'INSERT INTO feedback VALUES (?,?,?,?,?)',crypto.randomUUID(),now(),trim(body.articleId,128),type,text).run();
    return json({ok:true});
  }
  if(path==='/api/login' && method==='POST') {
    const {password}=await readBody(request,3000);
    await limit(db,request,'login',15,600000);
    if(typeof password!=='string'||!password || !await validPassword(password,env)) fail(401,'管理员密码错误。');
    const token=hex(crypto.getRandomValues(new Uint8Array(32)));
    const seconds=86400;
    await db.batch([statement(db,'DELETE FROM sessions WHERE expires<=?',Date.now()),statement(db,'INSERT INTO sessions VALUES (?,?)',await hash(token),Date.now()+seconds*1000)]);
    return json({ok:true},200,{'Set-Cookie':cookie(request,token,seconds)});
  }
  const token=getToken(request);
  const tokenHash=token && await hash(token);
  if(path==='/api/logout' && method==='POST') {
    if(tokenHash) await statement(db,'DELETE FROM sessions WHERE token=?',tokenHash).run();
    return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)});
  }
  if(!path.startsWith('/api/admin')) fail(404,'该页面不存在。');
  if(!tokenHash || !await statement(db,'SELECT token FROM sessions WHERE token=? AND expires>?',tokenHash,Date.now()).first()) fail(401,'请先登录管理后台。');
  if(path==='/api/admin' && method==='GET') return json(await adminData(db));
  if(path==='/api/admin/export' && method==='GET') return backup(env,await adminData(db));
  if(path==='/api/admin/article' && method==='POST') return editArticle(db,await readBody(request));
  if(path==='/api/admin/template' && method==='POST') {
    const {name,content}=await readBody(request);
    if(!trim(name,80)||!Array.isArray(content?.blocks))fail(400,'请输入模板名称并添加内容块。');
    const template={id:crypto.randomUUID(),name:trim(name,80),content};
    await statement(db,'INSERT INTO site_config(key,data) VALUES (?,?)','template:'+template.id,encode(template)).run();
    return json(template);
  }
  if(path==='/api/admin/config' && method==='POST') return editConfig(db,await readBody(request));
  if(path==='/api/admin/video' && method==='POST')return uploadVideo(request,env);
  if(path==='/api/admin/media' && method==='POST') return upload(env,await readBody(request,11500000));
  fail(404,'此管理功能不存在。');
}
export default {
  async fetch(request,env) {
    try { return await dispatch(request,env); }
    catch(error) {
      if(!error.status) console.error('API request failed',error.message);
      return json({error:error.status ? error.message : '服务器暂时无法完成操作，请重试。'},error.status||500);
    }
  }
};
