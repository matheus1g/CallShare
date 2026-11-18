// Render the shipped renderer in an isolated browser, with fake Discord state.
// No Discord app/session, VPN service, external fonts or network requests are used.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const release=require('./release-path.cjs'),version=release.version(),tag=version.replaceAll('.','');
const root=release.releasePath(),source=fs.readFileSync(path.join(root,'CallShare.plugin.js'),'utf8');
const css=/BdApi\.DOM\.addStyle\(NAME, `([\s\S]*?)`\);/.exec(source)?.[1];if(!css)throw Error('UI stylesheet missing');
const folder=fs.mkdtempSync(path.resolve('work/next/build/ui-'+tag+'-'));
const pluginSha256=crypto.createHash('sha256').update(source).digest('hex');
if(!process.argv.includes('--prepare')){const checked=JSON.parse(fs.readFileSync('work/next/build/ui-'+tag+'-results.json'));assert.equal(checked.pluginSha256,pluginSha256);assert.equal(checked.cases.length,3);for(const c of checked.cases)assert.equal(c.result.passed,true,c.theme);console.log(JSON.stringify({ui:'PASS',cases:3,pluginSha256}));process.exit(0);}
const script=String.raw`
const module={exports:{}};
window.BdApi={Data:{load(){},save(){}},UI:{showToast(){}},Plugins:{folder:''},DOM:{},Patcher:{}};
__PLUGIN__
const plugin=new module.exports(),calls=[];
plugin.running=true;plugin.routeStrategy='on-demand';plugin.routeProgress=[];plugin.nativeEnabled=true;plugin.routeDiagnostics=new RouteDiagnostics();
plugin.voiceChannelId=()=>'preview-call';plugin.onDemandEnabled=()=>true;plugin.gatewayTarget={};plugin.routeStatus='Em espera';
plugin.rtcStore={getRTCConnection:()=>({state:'RTC_CONNECTED'})};
plugin.autoPolicy={enabled:true,pausedCall:null,failure:null,report(){return {enabled:true,paused:!!this.pausedCall,state:this.failure?'failed':'active',failure:this.failure};}};
plugin.bootstrap={state:'idle',cancel(){calls.push('cancel');}};
plugin.forceReconnect=async()=>calls.push('connect');plugin.disableSessionRoute=async()=>calls.push('pause');plugin.suspendSessionRoute=async()=>calls.push('standby');
plugin.createToolbar();
const checks=[];function check(ok,label){checks.push({label,ok:!!ok});}
function state(mode){
  plugin.devMode=false;plugin.panelTab='general';
  plugin.autoPolicy.pausedCall=mode==='paused'?'preview-call':null;plugin.autoPolicy.failure=mode==='failure'?'CS_PROVIDER_NETWORK':null;plugin.lastRouteFailure=plugin.autoPolicy.failure;
  plugin.bootstrap.state=({active:'media',preparing:'preparing',verifying:'verifying',attention:'attention'})[mode]||'idle';plugin.routeDisableBusy=false;plugin.routeSwitchBusy=false;
  const standby=['standby','verifying','attention'].includes(mode);plugin.routeWarmReady=standby;plugin.voiceRouteReady=mode==='active';plugin.routeMode=standby?'standby':'voice-direct';
  plugin.sessionRoute=['paused','failure'].includes(mode)?null:{stopped:false,standby,lastStatus:{routingActive:mode==='active',standbyVerified:standby,provider:{selected:'coopvpn',sessionAgeMs:60000,standbyMs:45000,activeMs:15000}}};
  plugin.showPanel();
}
for(const mode of ['standby','preparing','verifying','active','paused','failure','attention']){
  state(mode);const panel=document.getElementById('callshare-panel'),rect=panel.getBoundingClientRect();
  check(rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1,mode+' fits viewport');
  check(panel.scrollWidth<=panel.clientWidth+1,mode+' has no horizontal overflow');
  check(document.activeElement===panel.querySelector('button'),mode+' focuses close');
  check(plugin.menuButton.getAttribute('aria-expanded')==='true',mode+' expanded');
  if(mode==='standby')check(plugin.panelConnect.textContent==='Pausar nesta call','standby action explicit');
  if(mode==='verifying')check(plugin.panelConnect.disabled&&plugin.connectionView().tone==='working','verification not green success');
  if(mode==='attention')check(plugin.routeShortcut.textContent==='Conferir tela','unconfirmed screen offers guidance');
  if(mode==='active'){plugin.panelConnect.click();check(calls.includes('standby')&&!calls.includes('pause'),'return to standby preserves automatic mode');}
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  check(!document.getElementById('callshare-panel'),'Escape closes '+mode);check(document.activeElement===plugin.menuButton,'focus returns '+mode);
}
state('standby');const beforeRoute=plugin.sessionRoute,beforeCalls=calls.length;
plugin.selectPanelTab('advanced');check(!plugin.panelPages.advanced.hidden&&!plugin.panelInstall.hidden,'maintenance stays accessible');
plugin.panelDevButton.click();check(document.getElementById('callshare-panel').getAttribute('data-mode')==='dev','dev mode available');
plugin.panelAdvanced.open=true;check(plugin.panelAdvanced.textContent.includes('ainda não é um filtro exclusivo de vídeo'),'dev retains full technical text');
plugin.panelDevButton.click();check(plugin.sessionRoute===beforeRoute&&calls.length===beforeCalls,'presentation toggle preserves session');
check(!plugin.panelPages.general.hidden,'return to simple General');plugin.positionPanel();
const color=getComputedStyle(plugin.panelConnect).color,bg=getComputedStyle(plugin.panelConnect).backgroundColor;
const toRgb=v=>v.match(/[\d.]+/g)?.slice(0,3).map(Number),lum=v=>toRgb(v).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);
const contrast=(Math.max(lum(color),lum(bg))+.05)/(Math.min(lum(color),lum(bg))+.05);check(contrast>=4.5,'button text contrast');
const result={passed:checks.every(c=>c.ok),checks,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},contrast};
const pre=document.createElement('pre');pre.id='qa-results';pre.hidden=true;pre.textContent=JSON.stringify(result);document.body.append(pre);
`;
const themes={dark:{surface:'#242429',text:'#e6e6ec',muted:'#bbbbc8',button:'#5865f2',secondary:'#41434a'},light:{surface:'#ffffff',text:'#303137',muted:'#555861',button:'#4752c4',secondary:'#e4e5e9'},custom:{surface:'#192d35',text:'#ebf7fa',muted:'#b4d0d9',button:'#3c51b4',secondary:'#29434e'}};
const results=[];
for(const [theme,width,height,dpr] of [['dark',1280,800,1],['light',360,800,1.25],['custom',560,800,1.5]]){
  const t=themes[theme],htmlFile=path.join(folder,theme+'.html'),png=path.join(folder,theme+'.png');
  const style=css.replaceAll('${ROOT}','callshare-toolbar').replaceAll('${PANEL}','callshare-panel');
  const html=`<!doctype html><meta charset="utf-8"><style>:root{--background-surface-high:${t.surface};--background-floating:${t.surface};--text-default:${t.text};--text-normal:${t.text};--text-strong:${t.text};--text-subtle:${t.muted};--text-muted:${t.muted};--control-brand-background-default:${t.button};--control-brand-text-default:white;--control-secondary-background-default:${t.secondary};--control-secondary-text-default:${t.text};--button-secondary-background:${t.secondary};--button-secondary-text:${t.text};--button-positive-background:#267941;--button-positive-text:white;--status-positive:#298446;--status-warning:#d29c18;--status-danger:#d24a4a;--border-muted:#80838b;--border-subtle:#80838b;--brand-500:${t.button}}body{margin:0;font-family:Arial;background:${theme==='light'?'#e7e8ec':'#14151a'};color:${t.text}}.panels_preview{position:fixed;bottom:8px;left:8px;width:288px;padding:8px;background:${t.surface};border-radius:10px}.profile{display:flex;gap:16px;align-items:center;padding:8px}button{cursor:pointer}${style}</style><body class="theme-${theme}"><div class="panels_preview"><div class="profile">Perfil · microfone · fone <button aria-label="Configurações de usuário">⚙</button></div></div><script>${script.replace('__PLUGIN__',()=>source).replaceAll('</script','<\/script')}</script></body>`;
  fs.writeFileSync(htmlFile,html);
  results.push({theme,html:htmlFile,width,height,dpr});
}
fs.writeFileSync('work/next/build/ui-'+tag+'-preview.json',JSON.stringify({pluginSha256,folder,cases:results},null,2));
console.log(JSON.stringify({preview:folder,pluginSha256}));
