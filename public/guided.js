export function stepReader(a,esc,rememberPart){
  const shell=document.querySelector('.read-shell'),article=shell.querySelector('article');
  const sections=[...article.querySelectorAll('.anchored')], pages=[];
  if(!sections.length)return;
  let phase='',current;
  for(const [i,b] of a.blocks.entries()){
    if(b.type==='heading')phase=b.title||'';
    if(!current||['step','heading','success'].includes(b.type)){
      if(!(b.type==='step'&&current?.type==='heading')){
        current={items:[],type:b.type,group:phase||({step:'跟着操作',success:'完成检查'}[b.type]||'开始之前'),title:b.title||'开始前先看'};
        pages.push(current);
      }else {current.type='step';current.title=b.title||phase;}
    }
    current.items.push(sections[i]);
  }
  shell.classList.add('guided');
  const aside=shell.querySelector('.read-aside'),toc=shell.querySelector('#read-toc');
  const progress=document.createElement('div');progress.className='guide-progress';aside.prepend(progress);
  let prev='';
  toc.innerHTML='<summary>步骤目录</summary>'+pages.map((p,i)=>{
    const group=p.group!==prev?'<small>'+esc(p.group)+'</small>':'';prev=p.group;
    return group+'<a href="#'+p.items[0].id+'" data-page="'+i+'"><i></i>'+esc(p.title)+'</a>';
  }).join('');
  const top=document.createElement('div'),bottom=document.createElement('div');
  top.className='guide-heading';bottom.className='guide-actions';
  article.querySelector('.anchored').before(top);
  sections.at(-1).after(bottom);
  const more=[...article.querySelectorAll('.read-more')];
  const key='al-steps:'+a.id+':'+(a.revision||0);
  let saved={};try{saved=JSON.parse(localStorage.getItem(key))||{}}catch{}
  const done=new Set(Array.isArray(saved.done)?saved.done:[]);
  function byHash(){return pages.findIndex(p=>p.items.some(s=>'#'+s.id===location.hash));}
  function show(index,scroll=false){
    index=Math.max(0,Math.min(index,pages.length-1));const page=pages[index];rememberPart(a,Number(page.items[0].id.slice(5)));
    progress.innerHTML='<span>学习进度 <b>第 '+(index+1)+' / '+pages.length+' 步</b></span><progress max="'+pages.length+'" value="'+done.size+'"></progress>';
    for(const [i,p] of pages.entries()){
      p.items.forEach(s=>s.hidden=i!==index);
      const link=toc.querySelector('[data-page="'+i+'"]');link.classList.toggle('done',done.has(i));
      if(i===index)link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');
    }
    const overview=index===0?'<div class="guide-cards"><div><b>完成目标</b><p>'+esc(a.summary||a.title)+'</p></div><div><b>适用设备</b><p>'+esc(a.device||'通用')+' · 约 '+esc(a.minutes||5)+' 分钟</p></div></div>':'';
    top.innerHTML='<small>第 '+(index+1)+' 步</small> '+esc(page.group)+'<h1>'+esc(page.title)+'</h1>'+overview;
    bottom.innerHTML=(index?'<button data-prev>← 上一步</button>':'')+'<button data-next>'+ (index===pages.length-1?(done.has(index)?'已完成 ✓':'完成本教程 ✓'):'完成，进入下一步 →')+'</button>';
    bottom.querySelector('[data-prev]')?.addEventListener('click',()=>go(index-1));
    bottom.querySelector('[data-next]').onclick=()=>{done.add(index);if(index<pages.length-1)go(index+1);else show(index)};
    more.forEach(el=>el.hidden=index!==pages.length-1);
    try{if(!new URLSearchParams(location.search).has('preview'))localStorage.setItem(key,JSON.stringify({index,done:[...done]}))}catch{}
    if(scroll){if(innerWidth<740)toc.open=false;window.scrollTo({top:0,behavior:'instant'});}
  }
  function go(i){const hash='#'+pages[i].items[0].id;if(location.hash!==hash)history.pushState(null,'',hash);show(i,true);}
  toc.onclick=e=>{const link=e.target.closest('[data-page]');if(link){e.preventDefault();go(Number(link.dataset.page));}};
  window.addEventListener('hashchange',()=>{const n=byHash();if(n>=0)show(n,true)});
  const initial=byHash();show(initial>=0?initial:(Number.isInteger(saved.index)?saved.index:0));
}
