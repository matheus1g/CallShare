// Only a new preparation may select a provider. Existing media is never migrated
// to restore a preference, and every failed worker must confirm cleanup first.
const {VpnTransport}=require('./vpn-transport.cjs');
const {RiseupBootstrap}=require('./riseup-bootstrap.cjs');
const {CoopBootstrap}=require('./coop-bootstrap.cjs');
const {routeProvider}=require('./route-diagnostics.cjs');
const {SESSION_LIMITS}=require('./session-contract.cjs');
const {PreparationBudget}=require('./preparation-budget.cjs');
const failure=code=>Object.assign(new Error(code),{code});
const providerFailures=new Set(['CS_PROVIDER_NETWORK','CS_PROVIDER_HTTP','CS_PROVIDER_TIMEOUT','CS_PROVIDER_FORMAT','CS_PROVIDER_SIZE',
  'CS_PROVIDER_POLICY','CS_PROVIDER_CA','CS_PROVIDER_IDENTITY','CS_PROVIDER_SERVICE','CS_PROVIDER_GATEWAY',
  'CS_VPN_TIMEOUT','CS_VPN_EXIT','CS_VPN_TLS','CS_VPN_AUTH',
  'CS_PROBE_CONNECT','CS_PROBE_TIMEOUT','CS_PROBE_DNS','CS_PROBE_REFUSED','CS_PROBE_TLS','CS_PROBE_HTTP',
  'CS_PROBE_NETWORK_UNREACHABLE','CS_PROBE_HOST_UNREACHABLE']);
class ProviderTransport {
  constructor({root,onStatus=()=>{},scope='rtc',voiceBypass=null,standby=false,Transport=VpnTransport,providers,now=()=>Date.now(),budgetOptions={},deadlineAt=Infinity}){
    Object.assign(this,{root,onStatus,scope,voiceBypass,standby,Transport,now});
    this.budgetOptions=budgetOptions;this.deadlineAt=deadlineAt;
    this.providers=providers||[{id:'riseup',Bootstrap:RiseupBootstrap},{id:'coopvpn',Bootstrap:CoopBootstrap}];
    if(this.providers.length<1||this.providers.length>2||this.providers.some(p=>!['riseup','coopvpn'].includes(p.id)))throw failure('CS_PROVIDER_POLICY');
    this.stopped=false;this.cleanupConfirmed=false;this.attempts=[];this.selected=null;this.connectedAt=null;this.endedAt=null;
    this.activeMs=0;this.standbyMs=0;this.mode=null;this.modeSince=null;this.switches=0;this.stopReason=null;
  }
  get broker(){return this.inner?.broker;}
  get port(){return this.inner?.port;}
  get nonce(){return this.inner?.nonce;}
  get routesVerified(){return !this.stopped&&this.inner?.routesVerified===true;}
  get failureStage(){return this.inner?.failureStage;}
  probeEvidence(){return this.inner?.probeEvidence?.()||null;}
  healthEvidence(){return this.inner?.healthEvidence?.()||null;}
  markMode(mode,now=this.now()){
    if(this.modeSince!==null){const delta=Math.max(0,now-this.modeSince);if(this.mode==='active')this.activeMs+=delta;else if(this.mode==='standby')this.standbyMs+=delta;}
    this.mode=mode;this.modeSince=mode?now:null;
  }
  providerEvidence(){
    const until=this.endedAt??this.now(),delta=this.modeSince===null?0:Math.max(0,until-this.modeSince);
    const network=this.inner?.broker?.last?.network;
    let relayTxBytes=null,relayRxBytes=null,relayCountersPartial=false;
    if(Array.isArray(network?.relays)){
      relayTxBytes=0;relayRxBytes=0;relayCountersPartial=network.relays.length>96||network.relayOverflow>0;
      for(const r of network.relays.slice(0,96)){
        if(!Number.isSafeInteger(r?.txBytes)||r.txBytes<0||!Number.isSafeInteger(r?.rxBytes)||r.rxBytes<0||
          !Number.isSafeInteger(relayTxBytes+r.txBytes)||!Number.isSafeInteger(relayRxBytes+r.rxBytes)){relayCountersPartial=true;continue;}
        relayTxBytes+=r.txBytes;relayRxBytes+=r.rxBytes;
      }
    }
    const attempts=this.attempts.map((a,i)=>({...a,timings:i===this.attempts.length-1?this.inner?.timings?.()||a.timings:a.timings}));
    return routeProvider({preferred:'riseup',selected:this.selected,policy:'riseup-first',attempts,
      connectedAt:this.connectedAt,endedAt:this.endedAt,sessionAgeMs:this.connectedAt===null?0:Math.max(0,until-this.connectedAt),
      activeMs:this.activeMs+(this.mode==='active'?delta:0),standbyMs:this.standbyMs+(this.mode==='standby'?delta:0),switches:this.switches,
      credentialExpiresAt:this.inner?.sessionInfo?.expiresAt,caExpiresAt:this.inner?.sessionInfo?.caExpiresAt,
      relayTxBytes,relayRxBytes,relayCountersPartial,relayCounterAt:network?.at,
      declaredSessionLimitSeconds:null,limitKnowledge:'not-published',stopReason:this.stopReason});
  }
  async start(){
    if(this.starting||this.inner||this.stopped)throw failure('CS_CANCELLED');this.starting=true;
    const total=new PreparationBudget({deadline:Math.min(this.deadlineAt,this.now()+SESSION_LIMITS.prepareMs),now:this.now,...this.budgetOptions});
    this.totalBudget=total;
    try{
      for(let i=0;i<this.providers.length;i++){
        total.assert();
        if(this.stopped)throw failure('CS_CANCELLED');
        const provider=this.providers[i],attempt={provider:provider.id,startedAt:this.now(),endedAt:null,result:'preparing',failure:null,cleanupConfirmed:false};
        this.selected=provider.id;this.attempts.push(attempt);let startupFailure=null,ready=false;
        this.onStatus({phase:'provider',provider:provider.id,fallback:i>0});
        const budget=new PreparationBudget({deadline:Math.min(total.deadline,this.now()+SESSION_LIMITS.attemptMs),now:this.now,code:'CS_PROVIDER_TIMEOUT',...this.budgetOptions});
        this.preparingBudget=budget;
        const inner=new this.Transport({root:this.root,scope:this.scope,voiceBypass:this.voiceBypass,standby:this.standby,Bootstrap:provider.Bootstrap,deadlineAt:budget.deadline,
          onStatus:value=>{
            if(this.stopped||this.inner!==inner||!value||typeof value!=='object')return;
            if(value.phase==='failed'){
              startupFailure=providerFailures.has(value.failure)?value.failure:value.failure||'CS_VPN_EXIT';
              if(!ready)return;
              this.onStatus({...value,provider:provider.id});this.stop('transport-failure').catch(()=>{});return;
            }
            if(value.phase==='connected')this.connectedAt??=this.now();
            if(value.phase!=='ready')this.onStatus({...value,provider:provider.id});
          }});
        this.inner=inner;
        try{
          await budget.run(()=>inner.start(),()=>inner.stop());total.assert();if(this.stopped)throw failure('CS_CANCELLED');if(startupFailure)throw failure(startupFailure);
          ready=true;attempt.result='ready';attempt.endedAt=this.now();this.connectedAt??=this.now();this.markMode(this.standby?'standby':'active');
          this.onStatus({phase:'ready',provider:provider.id,country:inner.country,routesVerified:inner.routesVerified});return;
        }catch(error){
          let cleanupError;try{await inner.stop();}catch{cleanupError=true;}
          attempt.endedAt=this.now();attempt.cleanupConfirmed=inner.cleanupConfirmed===true;
          attempt.timings=inner.timings?.()||[];
          const code=this.stopped?'CS_CANCELLED':startupFailure||error.code||(inner.failureStage==='provider'?'CS_PROVIDER_NETWORK':'CS_HELPER_INTERNAL');
          attempt.failure=/^CS_[A-Z_]{1,50}$/.test(code)?code:'CS_PROVIDER_NETWORK';attempt.result=this.stopped?'cancelled':'failed';
          if(cleanupError||!attempt.cleanupConfirmed)throw failure('CS_VPN_CLEANUP');
          total.assert();
          if(this.stopped||i===this.providers.length-1||!providerFailures.has(code))throw error.code===code?error:failure(attempt.failure);
          await total.run(()=>inner.broker?.waitRetired?.());
          this.connectedAt=null;this.onStatus({phase:'provider',provider:this.providers[i+1].id,fallback:true});
        }finally{budget.close();if(this.preparingBudget===budget)this.preparingBudget=null;}
      }
    }catch(error){await this.stop(this.stopped?'cancelled':'prepare-failed');throw error;}
    finally{total.close();this.totalBudget=null;this.starting=false;}
  }
  async setRouting(active){
    if(this.stopped)throw failure('CS_CANCELLED');
    const expiry=Date.parse(this.inner?.sessionInfo?.expiresAt);
    if(active&&Number.isFinite(expiry)&&this.now()>=expiry-60000){
      this.onStatus({phase:'failed',provider:this.selected,failure:'CS_PROVIDER_IDENTITY'});await this.stop('credential-expiring');throw failure('CS_PROVIDER_IDENTITY');
    }
    const state=await this.inner.setRouting(active);if(this.stopped)throw failure('CS_CANCELLED');
    if(this.standby!==!active)this.switches++;this.standby=!active;this.markMode(active?'active':'standby');return state;
  }
  stop(reason='requested'){
    if(this.stopping)return this.stopping;
    this.stopped=true;this.stopReason=reason;this.endedAt=this.now();this.markMode(null,this.endedAt);
    this.preparingBudget?.expire('CS_CANCELLED');this.totalBudget?.expire('CS_CANCELLED');
    return this.stopping=(async()=>{try{await this.inner?.stop();}catch{throw failure('CS_VPN_CLEANUP');}this.cleanupConfirmed=this.inner?this.inner.cleanupConfirmed===true:true;
      const current=this.attempts.at(-1);if(current?.result==='ready')current.cleanupConfirmed=this.cleanupConfirmed;
      if(!this.cleanupConfirmed)throw failure('CS_VPN_CLEANUP');})();
  }
}
module.exports={ProviderTransport,providerFailures};
