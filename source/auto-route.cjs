// Pure policy. This class cannot open a connection, inspect Discord or share a screen.
class AutoRoutePolicy {
    constructor({enabled=false,stableMs=5000}={}) {
        this.enabled=enabled===true;this.stableMs=stableMs;this.state=this.enabled?'waiting-call':'off';
        this.candidate=null;this.since=null;this.pending=false;this.pausedCall=null;this.failure=null;
        this.attempts=0;this.lastPrepareAt=null;this.retryAt=null;this.failureCount=0;
    }
    resetCandidate(){this.candidate=null;this.since=null;}
    enable(value){this.enabled=value===true;this.pending=false;this.failure=null;this.retryAt=null;this.failureCount=0;this.pausedCall=null;this.resetCandidate();this.state=this.enabled?'waiting-call':'off';}
    pause(call){this.pausedCall=call||null;this.pending=false;this.resetCandidate();this.state='paused';}
    resume(){this.pausedCall=null;this.failure=null;this.retryAt=null;this.failureCount=0;this.pending=false;this.resetCandidate();this.state=this.enabled?'waiting-call':'off';}
    fail(code,now=Date.now()){
        this.failure=/^CS_[A-Z_]{1,50}$/.test(code||'')?code:'CS_AUTO_PREPARE';this.pending=false;this.resetCandidate();this.failureCount=Math.min(10,this.failureCount+1);
        const manual=new Set(['CS_SERVICE_MISSING','CS_SERVICE_PROTOCOL','CS_SERVICE_AUTH','CS_SERVICE_ACCESS','CS_SERVICE_INPUT','CS_HELPER_MISSING','CS_HELPER_HASH','CS_HELPER_READ','CS_BD_API','CS_VOICE_OVERLAP','CS_PROCESS_DRIVER_BUSY','CS_ISOLATION_WFP','CS_PROVIDER_CA']);
        this.retryAt=manual.has(this.failure)?null:now+Math.min(120000,15000*Math.pow(2,this.failureCount-1));this.state=this.retryAt==null?'failed':'backoff';
    }
    settled(){this.pending=false;this.resetCandidate();}
    succeeded(){this.settled();this.failure=null;this.retryAt=null;this.failureCount=0;this.state='active';}
    tick(context,now=Date.now()) {
        const c=context||{};
        if(!this.enabled){this.state='off';return null;}
        if(c.restoring){this.state='restoring';this.resetCandidate();return null;}
        if(c.hasRoute){this.state=c.ready?'active':'preparing';return null;}
        if(c.busy){this.state='preparing';return null;}
        if(!c.call){this.state=this.failure?'failed':'waiting-call';this.pausedCall=null;this.resetCandidate();return null;}
        if(this.pausedCall && this.pausedCall!==c.call)this.pausedCall=null;
        if(this.pausedCall===c.call){this.state='paused';return null;}
        if(this.failure){if(this.retryAt==null){this.state='failed';return null;}if(now<this.retryAt){this.state='backoff';return null;}this.failure=null;this.retryAt=null;}
        if(!c.eligible || typeof c.key!=='string' || !c.key){this.state=c.streams?'waiting-media':'waiting-voice';this.resetCandidate();return null;}
        if(this.pending){this.state='preparing';return null;}
        if(this.candidate!==c.key){this.candidate=c.key;this.since=now;}
        if(this.since!=null&&now<this.since)this.since=now;
        if(this.since==null || now-this.since<this.stableMs){this.state='stabilizing';return null;}
        this.pending=true;this.state='preparing';this.attempts++;this.lastPrepareAt=now;
        return 'prepare-voice';
    }
    report(){return {enabled:this.enabled,state:this.state,failure:this.failure,attempts:this.attempts,lastPrepareAt:this.lastPrepareAt,paused:this.pausedCall!=null,stableMs:this.stableMs,retryAt:this.retryAt,failureCount:this.failureCount};}
}
if(typeof module!=='undefined')module.exports={AutoRoutePolicy};
