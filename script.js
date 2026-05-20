const chats={1:{name:"Single Dad",avatar:"https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=face",status:"Online",msgs:[{type:"received",text:"Hey there! How are you doing?",time:"9:30"},{type:"sent",text:"I'm good, just working on some designs.",time:"9:32"},{type:"received",text:"That sounds exciting! Would love to see them.",time:"9:33"},{type:"sent",text:"Sure, I'll share the mockups later today.",time:"9:35"},{type:"received",text:"Can't wait! Say hi to the team too.",time:"9:36"},{type:"sent",text:"Will do! Talk soon.",time:"9:38"}]},2:{name:"Seong-Su",avatar:"https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=face",status:"Online",msgs:[{type:"received",text:"it's me with my friends",time:"8:00"},{type:"sent",text:"Oh wow, that's a great photo!",time:"8:05"},{type:"received",text:"Thanks! We had so much fun.",time:"8:06"},{type:"sent",text:"Where was this taken?",time:"8:08"}]},3:{name:"Nathaniel Hanul",avatar:"https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=face",status:"typing...",msgs:[{type:"sent",text:"Did you finish the report?",time:"10:00"},{type:"received",text:"Almost done, just finalizing the charts.",time:"10:05"},{type:"sent",text:"Great, send it over when ready.",time:"10:06"},{type:"received",text:"Will do in 10 minutes.",time:"10:08"}]},4:{name:"God Kingdom",avatar:"https://images.unsplash.com/photo-1517841905240-472988babdf9?w=100&h=100&fit=crop&crop=face",status:"Online",msgs:[{type:"received",text:"Say hi",time:"Yesterday"},{type:"sent",text:"Hi! How's everything going?",time:"Yesterday"},{type:"received",text:"All good, just chilling today.",time:"Yesterday"},{type:"sent",text:"Same here. Let's catch up soon.",time:"Yesterday"}]},5:{name:"celebrity husband",avatar:"https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=100&h=100&fit=crop&crop=face",status:"Last seen 2h ago",msgs:[{type:"received",text:"Photo",time:"11:00"},{type:"sent",text:"Nice shot! What camera did you use?",time:"11:05"},{type:"received",text:"Just my phone, believe it or not.",time:"11:06"},{type:"sent",text:"The portrait mode is getting really good.",time:"11:08"}]},6:{name:"Mia Rose",avatar:"https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100&h=100&fit=crop&crop=face",status:"Online",msgs:[{type:"received",text:"Can we meet tomorrow?",time:"8:00"},{type:"sent",text:"Sure! What time works for you?",time:"8:02"},{type:"received",text:"How about 3 PM at the cafe?",time:"8:03"},{type:"sent",text:"Perfect. See you then!",time:"8:05"},{type:"received",text:"Don't forget to bring the documents.",time:"8:06"},{type:"sent",text:"Got them ready. See you!",time:"8:08"}]}};

const themes={lavender:{bg:"linear-gradient(135deg,#f3e7ff 0%,#ffeef8 50%,#e8e0ff 100%)",orb1:"rgba(212,196,251,0.8)",orb2:"rgba(248,205,218,0.7)",orb3:"rgba(224,195,252,0.6)"},ocean:{bg:"linear-gradient(135deg,#e0f7fa 0%,#b2ebf2 50%,#80deea 100%)",orb1:"rgba(128,222,234,0.8)",orb2:"rgba(178,235,242,0.7)",orb3:"rgba(224,247,250,0.6)"},sunset:{bg:"linear-gradient(135deg,#fff3e0 0%,#ffe0b2 50%,#ffcc80 100%)",orb1:"rgba(255,204,128,0.8)",orb2:"rgba(255,224,178,0.7)",orb3:"rgba(255,243,224,0.6)"}};

const sChats=document.getElementById('screenChats');
const sConv=document.getElementById('screenConv');
const sProfile=document.getElementById('screenProfile');
const sSettings=document.getElementById('screenSettings');
const msgBox=document.getElementById('messagesBox');
const convAv=document.getElementById('convAvatar');
const convNm=document.getElementById('convName');
const convSt=document.getElementById('convStatus');
const msgInput=document.getElementById('msgInput');
const sendBtn=document.getElementById('sendBtn');
let activeChat=null;

// Bug fix: sync nav active state
function setNavActive(view){
  document.querySelectorAll('.nav-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.view===view);
  });
}

function showScreen(n, navView){
  [sChats,sConv,sProfile,sSettings].forEach(s=>s.classList.remove('active'));
  const map={chats:sChats,conv:sConv,profile:sProfile,settings:sSettings};
  if(map[n]) map[n].classList.add('active');
  // Sync nav — conv and settings don't have nav tab so inherit caller's
  if(navView) setNavActive(navView);
  if(n==='chats'){
    activeChat=null;
    document.querySelectorAll('.chat-card').forEach((c,i)=>{
      c.classList.remove('show');
      setTimeout(()=>c.classList.add('show'), i*60);
    });
  }
}

function openChat(id){
  const d=chats[id];
  if(!d) return;
  activeChat=String(id);
  convAv.src=d.avatar;
  convAv.alt=d.name;
  convNm.textContent=d.name;
  convSt.textContent=d.status;
  // Bug fix: typing indicator only for chat 3
  renderMsgs(d.msgs, String(id)==='3');
  showScreen('conv');
}

function renderMsgs(list, typing){
  msgBox.innerHTML='';
  list.forEach((m,i)=>{
    const r=document.createElement('div');
    r.className=`msg-row ${m.type}`;
    r.style.animationDelay=`${i*0.05}s`;
    r.innerHTML=`<div class="msg-bubble">${m.text}</div><div class="msg-time">${m.time}</div>`;
    msgBox.appendChild(r);
  });
  if(typing){
    const t=document.createElement('div');
    t.className='msg-row received';
    t.style.animationDelay=`${list.length*0.05}s`;
    t.innerHTML='<div class="typing-bubble"><span></span><span></span><span></span></div>';
    msgBox.appendChild(t);
  }
  // Bug fix: scroll after paint
  requestAnimationFrame(()=>{ msgBox.scrollTop=msgBox.scrollHeight; });
}

function sendMsg(){
  const txt=msgInput.value.trim();
  if(!txt||!activeChat) return;
  const t=new Date();
  const ts=t.getHours()+':'+String(t.getMinutes()).padStart(2,'0');
  chats[activeChat].msgs.push({type:'sent',text:txt,time:ts});
  renderMsgs(chats[activeChat].msgs, activeChat==='3');
  msgInput.value='';
  // Bug fix: only auto-reply for non-typing chats so typing bubble isn't displaced weirdly
  setTimeout(()=>{
    chats[activeChat].msgs.push({type:'received',text:'Got it! Thanks for the update.',time:ts});
    renderMsgs(chats[activeChat].msgs, activeChat==='3');
  },1500);
}

function applyTheme(n){
  const t=themes[n];
  if(!t) return;
  document.body.style.background=t.bg;
  const orbs=document.querySelectorAll('.orb');
  orbs[0].style.background=t.orb1;
  orbs[1].style.background=t.orb2;
  orbs[2].style.background=t.orb3;
  document.querySelectorAll('.theme-card').forEach(c=>c.classList.toggle('active',c.dataset.theme===n));
}

// Events
sendBtn.addEventListener('click', sendMsg);
msgInput.addEventListener('keydown', e=>{ if(e.key==='Enter') sendMsg(); });

// Bug fix: back buttons sync nav
document.getElementById('backBtn').addEventListener('click',()=>{ showScreen('chats','chats'); });
document.getElementById('settingsBackBtn').addEventListener('click',()=>{ showScreen('profile','profile'); });
document.getElementById('settingsMenuItem').addEventListener('click',()=>{ showScreen('settings'); });

document.querySelectorAll('.chat-card').forEach(c=>{
  c.addEventListener('click',()=>openChat(c.dataset.id));
});

document.querySelectorAll('.nav-btn').forEach(b=>{
  b.addEventListener('click',()=>{
    const v=b.dataset.view;
    setNavActive(v);
    if(v==='chats'||v==='home') showScreen('chats','chats');
    else if(v==='profile') showScreen('profile','profile');
    // 'add' — no screen yet, stays on current
  });
});

document.querySelectorAll('.theme-card').forEach(c=>{
  c.addEventListener('click',()=>applyTheme(c.dataset.theme));
});

// Initial card animation
setTimeout(()=>{
  document.querySelectorAll('.chat-card').forEach((c,i)=>{
    setTimeout(()=>c.classList.add('show'), i*80);
  });
}, 200);

// Clock — Bug fix: consistent format
function updateClock(){
  const n=new Date();
  const el=document.getElementById('clockTime');
  if(el) el.textContent=n.getHours()+':'+String(n.getMinutes()).padStart(2,'0');
}
updateClock();
setInterval(updateClock, 60000);

// Orb parallax
document.addEventListener('mousemove', e=>{
  const x=(e.clientX/window.innerWidth-0.5)*15;
  const y=(e.clientY/window.innerHeight-0.5)*15;
  document.querySelectorAll('.orb').forEach((o,i)=>{
    const f=(i+1)*0.4;
    o.style.transform=`translate(${x*f}px,${y*f}px)`;
  });
});
