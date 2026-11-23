/* Import plain content into the same blocks used by the editor and reader. */
const maxFile = 32 * 1024 * 1024;
const supported = new Set(['heading','text','checklist','step','image','video','note','success','faq','related']);
const heading = 'h1,h2,h3,h4,h5,h6';
const clean = value => (value || '').trim();
const text = node => clean(node?.textContent);
function bodyText(node) {
  if (!node) return '';
  const copy = node.cloneNode(true);
  for (const el of copy.querySelectorAll('br')) el.replaceWith('\n');
  for (const el of copy.querySelectorAll('p,li,div,tr')) el.append('\n');
  return clean(copy.textContent).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n');
}
function normalize(path) {
  const parts = [];
  for (const word of path.replaceAll('\\','/al-helper/').split('/al-helper/')) {
    if (!word || word === '.') continue;
    if (word === '..') { if (!parts.length) throw Error('资源路径超出压缩包范围'); parts.pop(); }
    else parts.push(word);
  }
  return parts.join('/al-helper/');
}
// Read only requested entries from the central directory; also bound actual inflated bytes.
async function openZip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer);
  const u16 = n => view.getUint16(n,true), u32 = n => view.getUint32(n,true);
  let end = bytes.length - 22;
  while (end >= Math.max(0,bytes.length-65557) && u32(end)!==0x06054b50) end--;
  if (end < Math.max(0,bytes.length-65557)) throw Error('ZIP 文件不完整');
  const entries = new Map(), count = u16(end+10);
  if (count>2000) throw Error('请只打包本篇教程使用的文件');
  let pos = u32(end+16);
  for(let i=0;i<count;i++) {
    if(u32(pos)!==0x02014b50) throw Error('ZIP 目录格式错误');
    const size=u16(pos+28), flags=u16(pos+8);
    const path=normalize(new TextDecoder(flags&2048?'utf-8':'gb18030').decode(bytes.slice(pos+46,pos+46+size)));
    const entry={method:u16(pos+10),compressed:u32(pos+20),length:u32(pos+24),offset:u32(pos+42),flags};
    if(!path.startsWith('__MACOSX/')) entries.set(path,entry);
    pos+=46+size+u16(pos+30)+u16(pos+32);
  }
  async function extract(path,limit) {
    const e=entries.get(path);
    if(!e) throw Error('压缩包中缺少文件：'+path);
    if(e.length>limit || e.flags&1 || ![0,8].includes(e.method)) throw Error('文件过大、已加密或压缩方式不支持：'+path);
    const start=e.offset+30+u16(e.offset+26)+u16(e.offset+28);
    if(u32(e.offset)!==0x04034b50 || start+e.compressed>bytes.length) throw Error('ZIP 文件损坏');
    const blob=new Blob([bytes.subarray(start,start+e.compressed)]);
    if(!e.method && blob.size===e.length) return blob;
    if(!e.method) throw Error('ZIP 文件大小不符');
    const reader=blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks=[]; let total=0;
    while(true){const {done,value}=await reader.read(); if(done)break; total+=value.length;
      if(total>e.length || total>limit){await reader.cancel();throw Error('解压后的文件过大');} chunks.push(value);}
    if(total!==e.length) throw Error('ZIP 文件不完整');
    return new Blob(chunks);
  }
  const pages=[...entries.keys()].filter(p=>/\.html?$/i.test(p));
  if(pages.length!==1) throw Error('每个 ZIP 请放入一篇 HTML 教程及其配图');
  return {path:pages[0],extract};
}
function webLink(raw) {
  if(!raw || !/^(https?:\/\/|\/[^/])/i.test(raw)) return '';
  try {const url=new URL(raw,location.origin);return ['http:','https:'].includes(url.protocol)?url.href:'';} catch{return '';}
}
function explicitBlock(el) {
  const type=el.dataset.block;
  if(!supported.has(type))throw Error('无法识别模板内容块：'+type);
  const b={type,title:text(el.querySelector(heading))};
  const body=el.cloneNode(true);
  for(const item of body.querySelectorAll(heading+',img,[data-tip],[data-success]'))item.remove();
  b.text=bodyText(el.querySelector('[data-text]')||body);
  const img=el.querySelector('img');
  const clip=el.querySelector('video');if(clip)b.video=clip.getAttribute('src')||clip.querySelector('source')?.getAttribute('src')||'';
  if(img)b.image=img.getAttribute('src')||'';
  if(type==='step'){b.tip=bodyText(el.querySelector('[data-tip]'));b.success=bodyText(el.querySelector('[data-success]'));}
  if(type==='related')b.url=webLink(el.querySelector('a')?.getAttribute('href'));
  return b;
}
function genericBlocks(root,exclude) {
  const blocks=[];
  let parts=[];
  function flush(){const value=clean(parts.join('')).replace(/[ \t]+/g,' ');if(value)blocks.push({type:'text',text:value});parts=[];}
  function walk(node) {
    if(node.nodeType===3){parts.push(node.textContent);return;}
    if(node.nodeType!==1 || exclude.has(node))return;
    const tag=node.localName;
    if(node.matches(heading)){flush();blocks.push({type:'heading',title:text(node)});return;}
    if(tag==='video'){flush();blocks.push({type:'video',title:node.title||'教学视频',video:node.getAttribute('src')||node.querySelector('source')?.getAttribute('src')||''});return;}
    if(tag==='img'){flush();blocks.push({type:'image',title:node.alt,image:node.getAttribute('src')});return;}
    if(tag==='a' && webLink(node.getAttribute('href'))){flush();blocks.push({type:'related',title:text(node)||'相关链接',url:webLink(node.getAttribute('href'))});return;}
    if(tag==='br'){parts.push('\n');return;}
    const paragraph=/^(p|div|li|section|article|tr|pre|blockquote|figure|figcaption)$/.test(tag);
    if(paragraph)flush();
    for(const child of node.childNodes)walk(child);
    if(paragraph)flush();
  }
  for(const child of root.childNodes)walk(child);flush();return blocks;
}
export async function importTutorial(file,categories,upload,onProgress) {
  if(file.size>maxFile)throw Error('请选择 32 MB 以内的 HTML 或 ZIP');
  const zip=/\.zip$/i.test(file.name)?await openZip(file):null;
  const html=zip?await zip.extract(zip.path,maxFile):file;
  const holder=document.createElement('template');
  holder.innerHTML=await html.text();
  const doc=holder.content;
  for(const el of doc.querySelectorAll('script,style,iframe,object,embed,form,nav,footer,noscript,svg,[hidden],[data-template-only]'))el.remove();
  const root=doc.querySelector('[data-al-tutorial],article,main')||doc;
  const h1=root.querySelector('h1'), summary=root.querySelector('[data-summary]');
  const dataset=root.dataset||{};
  const category=categories.find(c=>c.id===dataset.category||c.name===dataset.category)||categories.find(c=>!c.hidden);
  const marked=[...root.querySelectorAll('[data-block]')];
  const title=text(h1)||text(doc.querySelector('title'))||(zip?.path||file.name).split('/al-helper/').pop().replace(/\.html?$/i,'');
  const excluded=new Set([h1,summary,...doc.querySelectorAll('head,title,meta,link')]);
  const blocks=marked.length?marked.map(explicitBlock):genericBlocks(root,excluded);
  if(!blocks.length)throw Error('未找到可导入的正文，请检查网页或使用教程模板');
  const warnings=new Set(), cache=new Map();
  async function imageUrl(src) {
    if(!src)return '';
    if(/^https?:\/\//i.test(src))return webLink(src);
    if(/^\/(api\/media|examples)\//.test(src))return webLink(src);
    let data,name;
    if(/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src)){data=src.replace(/\s/g,'');name='教程配图.'+src.slice(11,src.indexOf(';'));}
    else if(zip && !/^[a-z]+:|^\/\//i.test(src)){
      const relative=decodeURIComponent(src.split(/[?#]/)[0]);
      const path=normalize((relative.startsWith('/al-helper/')?'':zip.path.replace(/[^/]*$/,''))+relative);
      const ext=path.split('.').pop().toLowerCase(),mime={jpg:'jpeg',jpeg:'jpeg',png:'png',webp:'webp',gif:'gif'}[ext];
      if(!mime)throw Error('不支持该图片格式');
      const blob=await zip.extract(path,8*1024*1024);name=path.split('/al-helper/').pop();
      data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('读取图片失败'));r.readAsDataURL(new Blob([blob],{type:'image/'+mime}));});
    }else throw Error('本地配图请随 HTML 打包为 ZIP；内嵌图片支持 PNG、JPG、WebP、GIF');
    return (await upload({name,data})).url;
  }
  for(const b of blocks)if(b.image){
    const src=b.image;
    if(!cache.has(src)){onProgress('正在处理教程配图…');
      try{cache.set(src,await imageUrl(src));}
      catch(e){if(e.status===401||e.status>=500)throw e;warnings.add((src.startsWith('data:')?'内嵌图片':src.slice(0,120))+'：'+e.message);cache.set(src,'');}}
    b.image=cache.get(src);
  }
  for(const b of blocks)if(b.video){
    const src=b.video;
    if(/^https?:\/\//i.test(src)||/^\/api\/media\//.test(src)){b.video=webLink(src);continue;}
    if(zip && /\.(mp4|webm)$/i.test(src)){
      const path=normalize(zip.path.replace(/[^/]*$/,'')+decodeURIComponent(src));
      const blob=await zip.extract(path,64*1024*1024);
      onProgress('正在上传教学视频…');
      const response=await fetch('/al-helper/api/admin/video?name='+encodeURIComponent(path.split('/al-helper/').pop()),{method:'POST',headers:{'Content-Type':/\.webm$/i.test(src)?'video/webm':'video/mp4'},body:blob});
      const result=await response.json();if(!response.ok)throw Error(result.error||'视频上传失败');b.video=result.url;
    }else{b.video='';warnings.add('请在编辑器中上传视频：'+src.slice(0,100))}
  }
  return {content:{title,layout:dataset.layout==='steps'?'steps':'classic',summary:text(summary)||clean(doc.querySelector('meta[name="description"]')?.content)||blocks.find(b=>b.text)?.text.slice(0,100)||'',category:category?.id||'',device:['电脑','手机','通用'].includes(dataset.device)?dataset.device:'通用',minutes:Math.max(1,parseInt(dataset.minutes)||5),tags:(dataset.tags||'').split(/[,，、]/).map(clean).filter(Boolean),status:'新发布',order:99,blocks,related:[]},warnings:[...warnings]};
}
