const API = window.location.origin;
const DAY_MIN = window.DAY_MIN || 3;
const DAY_MAX = window.DAY_MAX || 9;
const AREA_SPAN = window.AREA_SPAN || {};
let token = localStorage.getItem("parada_token") || "";
let currentUser = null, ACTIVITIES = [], ALL_ACTIVITIES = [], doneSet = new Set();
let TOTAL_H = 0, TOTAL_N = 0, chartS, chartResp, ws, tlCollapsed = false;
let filterStatus = "", filterAreas = new Set(), filterResps = new Set(), filterDate = "", filterGanttOp = "";

function toast(m){const t=document.getElementById("toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1800)}
function switchTab(id){
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===id));
  document.querySelectorAll(".tab-panel").forEach(p=>p.classList.toggle("active",p.id==="tab-"+id));
  if(id==="curvas"||id==="equipe") setTimeout(buildCharts,60);
}
async function api(path, opts={}){
  const headers=opts.headers||{};
  if(token) headers.Authorization="Bearer "+token;
  if(opts.body&&!(opts.body instanceof FormData)){headers["Content-Type"]="application/json";opts.body=JSON.stringify(opts.body)}
  const r=await fetch(API+path,{...opts,headers});
  if(r.status===401){doLogout();throw new Error("Não autenticado")}
  if(!r.ok){const e=await r.json().catch(()=>({detail:r.statusText}));throw new Error(typeof e.detail==="string"?e.detail:"Erro API")}
  return r.json();
}
async function doLogin(){
  const u=document.getElementById("loginUser").value.trim(),p=document.getElementById("loginPass").value;
  const err=document.getElementById("loginErr");err.style.display="none";
  try{
    const body=new URLSearchParams({username:u,password:p});
    const r=await fetch(API+"/api/login",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
    if(!r.ok) throw new Error("fail");
    const data=await r.json();token=data.access_token;currentUser=data.user;
    localStorage.setItem("parada_token",token);localStorage.setItem("parada_user",JSON.stringify(currentUser));
    await bootApp();
  }catch(e){err.style.display="block"}
}
function doLogout(){
  token="";currentUser=null;localStorage.removeItem("parada_token");localStorage.removeItem("parada_user");
  try{ws&&ws.close()}catch(e){}
  document.getElementById("app").style.display="none";document.getElementById("loginScreen").style.display="flex";
}
async function bootApp(){
  document.getElementById("loginScreen").style.display="none";document.getElementById("app").style.display="block";
  document.getElementById("userName").textContent=currentUser.full_name;
  document.getElementById("userRole").textContent=currentUser.role;
  const isOp=currentUser.role==="operador";
  if(currentUser.role==="admin"||currentUser.role==="supervisor") document.getElementById("btnReset").style.display="";
  const isSup = currentUser.role === "supervisor";
  document.querySelectorAll(".mgr-only").forEach(el=>{el.style.display=isOp?"none":""});
  document.querySelectorAll(".tab.mgr-only").forEach(t=>{t.style.display=isOp?"none":""});
  // Supervisor: hide Tarefas tab; Admin sees everything
  document.querySelectorAll(".op-tab").forEach(t=>{
    if (isSup) t.style.display = "none";
    else if (isOp) t.style.display = "";
    else t.style.display = ""; // admin
  });
  document.getElementById("headerSub").textContent=isOp?"Minhas atividades":(isSup?"Visão supervisor":"Online · Compartilhado");
  document.getElementById("progScope").textContent=isOp?"Pessoal ("+currentUser.full_name+")":"Geral";
  ALL_ACTIVITIES=await api("/api/activities");
  if(isOp){
    const name=(currentUser.full_name||"").toUpperCase().trim();
    const aliases={"IBSON":["IBSON","NIBSON"],"NIBSON":["IBSON","NIBSON"]};
    const names=aliases[name]||[name];
    ACTIVITIES=ALL_ACTIVITIES.filter(a=>names.includes((a.resp||"").toUpperCase().trim()));
  }else ACTIVITIES=ALL_ACTIVITIES;
  TOTAL_N=ACTIVITIES.length;TOTAL_H=ACTIVITIES.reduce((s,a)=>s+a.dur,0);
  document.getElementById("kpiTotal").textContent=TOTAL_N;
  document.getElementById("kpiTotalH").textContent=TOTAL_H.toFixed(0)+" h";
  buildChipFilters();await loadProgress();
  if(isOp){const myIds=new Set(ACTIVITIES.map(a=>a.id));doneSet=new Set([...doneSet].filter(id=>myIds.has(id)))}
  connectWS();
  if(currentUser.role==="supervisor") switchTab("gantt"); else switchTab("tarefas");
  render();
}
async function loadProgress(){const p=await api("/api/progress");doneSet=new Set(p.done_ids||[])}
function connectWS(){
  const proto=location.protocol==="https:"?"wss:":"ws:";
  try{
    ws=new WebSocket(proto+"//"+location.host+"/ws");
    ws.onmessage=async ev=>{
      try{
        const msg=JSON.parse(ev.data);
        if(msg.type==="progress"){
          const isOp=currentUser.role==="operador";
          const myIds=isOp?new Set(ACTIVITIES.map(a=>a.id)):null;
          if(isOp&&myIds&&!myIds.has(msg.activity_id))return;
          if(msg.done)doneSet.add(msg.activity_id);else doneSet.delete(msg.activity_id);
          render();
          if(msg.by!==currentUser.full_name)toast(msg.by+(msg.done?" concluiu #":" reabriu #")+msg.activity_id);
        }else if(msg.type==="reset"||msg.type==="reload"){
          await loadProgress();
          if(currentUser.role==="operador"){const myIds=new Set(ACTIVITIES.map(a=>a.id));doneSet=new Set([...doneSet].filter(id=>myIds.has(id)))}
          render();toast("Atualizado");
        }
      }catch(e){}
    };
    ws.onclose=()=>setTimeout(connectWS,4000);
    setInterval(()=>{try{ws.send("ping")}catch(e){}},25000);
  }catch(e){}
}
async function toggle(id){
  const newDone=!doneSet.has(id);
  try{
    await api("/api/progress",{method:"POST",body:{activity_id:id,done:newDone}});
    if(newDone)doneSet.add(id);else doneSet.delete(id);
    render();toast(newDone?"✓ Concluída":"Desmarcada");
  }catch(e){toast("Erro: "+e.message)}
}
function openResetModal(){document.getElementById("resetPassword").value="";document.getElementById("resetError").style.display="none";document.getElementById("resetModal").classList.add("show")}
function closeResetModal(){document.getElementById("resetModal").classList.remove("show")}
async function confirmReset(){
  if(document.getElementById("resetPassword").value!=="654321"){document.getElementById("resetError").style.display="block";return}
  try{await api("/api/progress/reset",{method:"POST"});doneSet.clear();closeResetModal();render();toast("Resetado")}
  catch(e){document.getElementById("resetError").style.display="block"}
}
function buildChipFilters(){
  // Datas da parada presentes nas atividades do usuário
  const days=[...new Set(ACTIVITIES.map(a=>{
    try{return parseInt(String(a.data).split("/")[0],10)}catch(e){return null}
  }).filter(Boolean))].sort((a,b)=>a-b);
  const wd=["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  const dateBox=document.getElementById("dateChips");
  if(dateBox){
    dateBox.innerHTML='<span class="filter-label">Data</span><button class="chip on" data-date="" onclick="setDate(this)">Todas</button>'+
      days.map(d=>{
        const name=wd[new Date(2026,7,d).getDay()];
        return `<button class="chip" data-date="${d}" onclick="setDate(this)">${name} ${String(d).padStart(2,"0")}/08</button>`;
      }).join("");
  }
  const areas=[...new Set(ACTIVITIES.map(a=>a.area))].sort();
  const resps=[...new Set(ACTIVITIES.map(a=>a.resp))].sort();
  const areaEl=document.getElementById("areaChips");
  if(areaEl) areaEl.innerHTML='<span class="filter-label">Setor</span><button class="chip on" data-area="" onclick="setArea(this)">Todos</button>'+
    areas.map(a=>`<button class="chip" data-area="${a}" onclick="setArea(this)">${a.length>16?a.slice(0,14)+'…':a}</button>`).join("");
  const respEl=document.getElementById("respChips");
  if(respEl) respEl.innerHTML='<span class="filter-label">Pessoa</span><button class="chip on" data-resp="" onclick="setResp(this)">Todos</button>'+
    resps.map(r=>`<button class="chip" data-resp="${r}" onclick="setResp(this)">${r}</button>`).join("");
  buildGanttOpChips();
}
function setDate(btn){
  document.querySelectorAll("#dateChips .chip").forEach(b=>b.classList.remove("on"));
  btn.classList.add("on");
  filterDate=btn.dataset.date||"";
  renderTasks();
}
function buildGanttOpChips(){
  const box=document.getElementById("ganttOpChips");
  if(!box) return;
  const resps=[...new Set(ALL_ACTIVITIES.map(a=>a.resp).filter(Boolean))].sort();
  box.innerHTML='<span class="filter-label">Operador</span><button class="chip on" data-gop="" onclick="setGanttOp(this)">Todos</button>'+
    resps.map(r=>`<button class="chip" data-gop="${r}" onclick="setGanttOp(this)">${r}</button>`).join("");
}
function setGanttOp(btn){
  document.querySelectorAll("#ganttOpChips .chip").forEach(b=>b.classList.remove("on"));
  btn.classList.add("on");
  filterGanttOp=btn.dataset.gop||"";
  renderOpProgress();
  renderGantt();
}
function renderOpProgress(){
  const box=document.getElementById("opProgressCards");
  if(!box) return;
  const resps=[...new Set(ALL_ACTIVITIES.map(a=>a.resp).filter(Boolean))].sort();
  const list=filterGanttOp?resps.filter(r=>r===filterGanttOp):resps;
  box.innerHTML=list.map(r=>{
    const mine=ALL_ACTIVITIES.filter(a=>a.resp===r);
    const totalH=mine.reduce((s,a)=>s+a.dur,0);
    const doneH=mine.filter(a=>doneSet.has(a.id)).reduce((s,a)=>s+a.dur,0);
    const doneN=mine.filter(a=>doneSet.has(a.id)).length;
    const pct=totalH?doneH/totalH*100:0;
    return `<div style="background:#0f172a;border:1px solid var(--border);border-radius:10px;padding:.65rem">
      <div style="font-weight:700;font-size:.85rem;margin-bottom:.25rem">${r}</div>
      <div style="font-size:1.25rem;font-weight:800;color:${pct>=100?'var(--green)':pct>0?'var(--accent)':'var(--muted)'}">${pct.toFixed(0)}%</div>
      <div style="font-size:.68rem;color:var(--muted);margin-top:.2rem">${doneN}/${mine.length} atv · ${doneH.toFixed(1)}/${totalH.toFixed(1)} h</div>
      <div style="height:6px;background:#1a2332;border-radius:4px;margin-top:.4rem;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#0ea5e9,#22c55e);border-radius:4px"></div>
      </div>
    </div>`;
  }).join("");
}
function setStatus(btn){document.querySelectorAll("[data-status]").forEach(b=>b.classList.remove("on"));btn.classList.add("on");filterStatus=btn.dataset.status||"";renderTasks()}
function setArea(btn){
  const v=btn.dataset.area;
  if(!v){filterAreas.clear();document.querySelectorAll("#areaChips .chip").forEach(b=>b.classList.toggle("on",b.dataset.area===""))}
  else{document.querySelector('#areaChips [data-area=""]').classList.remove("on");btn.classList.toggle("on");
    if(btn.classList.contains("on"))filterAreas.add(v);else filterAreas.delete(v);
    if(!filterAreas.size)document.querySelector('#areaChips [data-area=""]').classList.add("on")}
  renderTasks();
}
function setResp(btn){
  const v=btn.dataset.resp;
  if(!v){filterResps.clear();document.querySelectorAll("#respChips .chip").forEach(b=>b.classList.toggle("on",b.dataset.resp===""))}
  else{document.querySelector('#respChips [data-resp=""]').classList.remove("on");btn.classList.toggle("on");
    if(btn.classList.contains("on"))filterResps.add(v);else filterResps.delete(v);
    if(!filterResps.size)document.querySelector('#respChips [data-resp=""]').classList.add("on")}
  renderTasks();
}
function filteredActs(){
  const q=(document.getElementById("filterTag").value||"").toLowerCase();
  return ACTIVITIES.filter(a=>{
    const isDone=doneSet.has(a.id);
    if(filterStatus==="done"&&!isDone)return false;
    if(filterStatus==="pending"&&isDone)return false;
    if(filterDate){
      let d=0;try{d=parseInt(String(a.data).split("/")[0],10)}catch(e){}
      if(String(d)!==String(filterDate))return false;
    }
    if(filterAreas.size&&!filterAreas.has(a.area))return false;
    if(filterResps.size&&!filterResps.has(a.resp))return false;
    if(q&&!(a.tag||"").toLowerCase().includes(q)&&!(a.desc||"").toLowerCase().includes(q)&&!(a.area||"").toLowerCase().includes(q))return false;
    return true;
  });
}
function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function renderTasks(){
  const list=filteredActs();
  document.getElementById("emptyMsg").style.display=list.length?"none":"block";
  document.getElementById("taskList").innerHTML=list.map(a=>{
    const isDone=doneSet.has(a.id);
    return `<div class="task-card ${isDone?"done":""}"><button class="check-btn ${isDone?"checked":""}" onclick="toggle(${a.id})">${isDone?"✓":""}</button>
      <div class="task-body"><div class="task-title">#${a.id} · ${esc(a.tag)}</div><div class="task-desc">${esc(a.desc)}</div>
      <div class="task-meta"><span class="meta-pill tag">${esc(a.area)}</span><span class="meta-pill">${a.dur}h</span>
      <span class="meta-pill">${esc(a.data)} ${esc(a.inicio)}–${esc(a.fim)}</span>
      <span class="meta-pill ${a.turno==="A"?"turno-a":"turno-b"}">${esc(a.resp)} · T${a.turno}</span></div></div></div>`;
  }).join("");
  document.getElementById("tbody").innerHTML=list.map(a=>{
    const isDone=doneSet.has(a.id);
    return `<tr class="${isDone?"done":""}"><td><button class="check-btn ${isDone?"checked":""}" onclick="toggle(${a.id})">${isDone?"✓":""}</button></td>
      <td>${a.id}</td><td>${esc(a.area)}</td><td><span class="meta-pill tag">${esc(a.tag)}</span></td><td>${esc(a.desc)}</td>
      <td>${a.dur}</td><td>${esc(a.data)}</td><td>${esc(a.inicio)}–${esc(a.fim)}</td><td>${esc(a.resp)}</td>
      <td class="${a.turno==="A"?"turno-a":"turno-b"}">${a.turno}</td></tr>`;
  }).join("");
}
function updateKPIs(){
  let doneN=0,doneH=0;ACTIVITIES.forEach(a=>{if(doneSet.has(a.id)){doneN++;doneH+=a.dur}});
  const pendingN=TOTAL_N-doneN,pendingH=TOTAL_H-doneH;
  const pctH=TOTAL_H?doneH/TOTAL_H*100:0,pctN=TOTAL_N?doneN/TOTAL_N*100:0;
  document.getElementById("kpiDone").textContent=doneN;document.getElementById("kpiDoneH").textContent=doneH.toFixed(1)+" h";
  document.getElementById("kpiPending").textContent=pendingN;document.getElementById("kpiPendingH").textContent=pendingH.toFixed(1)+" h";
  document.getElementById("kpiPctH").textContent=pctH.toFixed(1)+"%";document.getElementById("kpiPctN").textContent=pctN.toFixed(1)+"%";
  document.getElementById("progPct").textContent=pctH.toFixed(1)+"%";document.getElementById("progBar").style.width=pctH+"%";
  document.getElementById("progLabel").textContent=doneN+" de "+TOTAL_N+" · "+doneH.toFixed(1)+" de "+TOTAL_H.toFixed(0)+" h";
  document.getElementById("badgeDone").textContent=doneN+" ok";document.getElementById("badgePending").textContent=pendingN+" pend.";
}
function renderGantt(){
  const totalDays=DAY_MAX-DAY_MIN+1;
  let html='<div class="gantt-header"><div></div><div class="gantt-days" style="grid-template-columns:repeat('+totalDays+',1fr)">';
  for(let d=DAY_MIN;d<=DAY_MAX;d++){const wd=["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"][new Date(2026,7,d).getDay()];html+=`<span>${wd} ${String(d).padStart(2,"0")}</span>`}
  html+='</div></div>';
  // When filtering by operator, recompute span from their activities only
  let spans=AREA_SPAN;
  if(filterGanttOp){
    const mine=ALL_ACTIVITIES.filter(a=>a.resp===filterGanttOp);
    spans={};
    mine.forEach(a=>{
      let d=3;try{d=parseInt(String(a.data).split("/")[0],10)}catch(e){}
      if(!spans[a.area]) spans[a.area]={min:d,max:d,hours:0,ids:[]};
      spans[a.area].min=Math.min(spans[a.area].min,d);
      spans[a.area].max=Math.max(spans[a.area].max,d);
      spans[a.area].hours+=a.dur;
      spans[a.area].ids.push(a.id);
    });
  }
  Object.keys(spans).forEach(area=>{
    const sp=spans[area],leftPct=((sp.min-DAY_MIN)/totalDays)*100,widthPct=((sp.max-sp.min+1)/totalDays)*100;
    let doneH=0;sp.ids.forEach(id=>{if(doneSet.has(id)){const a=ALL_ACTIVITIES.find(x=>x.id===id);if(a)doneH+=a.dur}});
    const pct=sp.hours>0?(doneH/sp.hours*100):0;
    let cls="gantt-bar";if(pct>=99.9)cls+=" done";else if(pct>0)cls+=" partial";
    const label=area.length>20?area.slice(0,18)+"…":area;
    html+=`<div class="gantt-row"><div class="gantt-label" title="${area}">${label}</div><div class="gantt-track" style="grid-template-columns:repeat(${totalDays},1fr)">
      <div class="${cls}" style="left:${leftPct}%;width:${widthPct}%;--pct:${pct}%">${String(sp.min).padStart(2,"0")}–${String(sp.max).padStart(2,"0")}</div></div></div>`;
  });
  const el=document.getElementById("gantt");if(el)el.innerHTML=html;
}
function buildCharts(){
  if(!TOTAL_H)return;
  const sorted=[...ACTIVITIES].sort((a,b)=>new Date(a.start_iso)-new Date(b.start_iso));
  const planBuckets={};let cum=0;
  sorted.forEach(a=>{cum+=a.dur;const end=new Date(new Date(a.start_iso).getTime()+a.dur*3600000);
    const key=String(end.getDate()).padStart(2,"0")+"/"+String(end.getMonth()+1).padStart(2,"0")+" "+String(end.getHours()).padStart(2,"0")+":00";
    planBuckets[key]=+(cum/TOTAL_H*100).toFixed(2)});
  const labels=Object.keys(planBuckets),planData=labels.map(k=>planBuckets[k]);
  const doneActs=ACTIVITIES.filter(a=>doneSet.has(a.id)).sort((a,b)=>new Date(a.start_iso)-new Date(b.start_iso));
  let c=0;const doneEnds=doneActs.map(a=>{c+=a.dur;return{ts:new Date(a.start_iso).getTime()/1000+a.dur*3600,cum:c/TOTAL_H*100}});
  const actualData=labels.map(lab=>{const day=parseInt(lab.split("/")[0]),hour=parseInt(lab.split(" ")[1]);
    const ts=new Date(2026,7,day,hour).getTime()/1000;let best=0;doneEnds.forEach(p=>{if(p.ts<=ts+1800)best=p.cum});return +best.toFixed(2)});
  const resps={};ACTIVITIES.forEach(a=>{const r=a.resp||"—";if(!resps[r])resps[r]={plan:0,done:0};resps[r].plan+=a.dur;if(doneSet.has(a.id))resps[r].done+=a.dur});
  const rn=Object.keys(resps).sort((a,b)=>resps[b].plan-resps[a].plan);
  const tick="#94a3b8",grid="#243044";
  const sEl=document.getElementById("chartS"),rEl=document.getElementById("chartResp");
  if(sEl){if(chartS)chartS.destroy();chartS=new Chart(sEl,{type:"line",data:{labels,datasets:[
    {label:"Planejado %",data:planData,borderColor:"#64748b",borderDash:[5,5],backgroundColor:"transparent",tension:.25,pointRadius:2},
    {label:"Realizado %",data:actualData,borderColor:"#22c55e",backgroundColor:"rgba(34,197,94,.12)",fill:true,tension:.25,pointRadius:2,pointBackgroundColor:"#22c55e"}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:tick,boxWidth:12}}},
    scales:{y:{min:0,max:100,ticks:{color:tick,callback:v=>v+"%"},grid:{color:grid}},x:{ticks:{color:tick,maxRotation:45,autoSkip:true,maxTicksLimit:12,font:{size:9}},grid:{display:false}}}}})}
  if(rEl){if(chartResp)chartResp.destroy();chartResp=new Chart(rEl,{type:"bar",data:{labels:rn,datasets:[
    {label:"Planejado",data:rn.map(r=>+resps[r].plan.toFixed(1)),backgroundColor:"#334155",borderRadius:4},
    {label:"Concluído",data:rn.map(r=>+resps[r].done.toFixed(1)),backgroundColor:"#a78bfa",borderRadius:4}
  ]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:tick,boxWidth:12}}},
    scales:{x:{beginAtZero:true,ticks:{color:tick},grid:{color:grid}},y:{ticks:{color:tick,font:{size:10}},grid:{display:false}}}}})}
}
function toggleTimeline(){tlCollapsed=!tlCollapsed;document.getElementById("tlBody").classList.toggle("collapsed",tlCollapsed);document.getElementById("tlToggleText").textContent=tlCollapsed?"Expandir":"Recolher"}
async function exportGanttPDF(){
  const btn=document.getElementById("btnPdfGantt");const was=tlCollapsed;
  if(tlCollapsed){tlCollapsed=false;document.getElementById("tlBody").classList.remove("collapsed")}
  btn.textContent="…";btn.disabled=true;await new Promise(r=>setTimeout(r,250));
  try{
    const el=document.querySelector("#tab-gantt .card");
    const canvas=await html2canvas(el,{backgroundColor:"#141c2b",scale:2,logging:false});
    const {jsPDF}=window.jspdf;const pdf=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
    const pageW=pdf.internal.pageSize.getWidth(),pageH=pdf.internal.pageSize.getHeight(),m=10;
    pdf.setFillColor(15,23,42);pdf.rect(0,0,pageW,18,"F");pdf.setTextColor(226,232,240);pdf.setFontSize(12);
    pdf.text("Gantt – Parada Elétrica",m,11);
    const img=canvas.toDataURL("image/png");const imgH=(canvas.height*(pageW-2*m))/canvas.width;
    pdf.addImage(img,"PNG",m,22,pageW-2*m,Math.min(imgH,pageH-32));pdf.save("Grok_Gantt.pdf");toast("PDF exportado");
  }catch(e){toast("Erro PDF")}
  if(was){tlCollapsed=true;document.getElementById("tlBody").classList.add("collapsed")}
  btn.innerHTML="📄 PDF";btn.disabled=false;
}
function render(){updateKPIs();renderGantt();renderOpProgress();renderTasks();buildCharts()}
(async()=>{
  const saved=localStorage.getItem("parada_user");
  if(token&&saved){try{currentUser=JSON.parse(saved);await api("/api/me");await bootApp()}catch(e){doLogout()}}
})();
