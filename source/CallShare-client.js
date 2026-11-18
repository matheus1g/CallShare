/**
 * @name CallShare
 * @author Mathe
 * @version 0.16.1
 * @description Prepara uma rota nativa para o Discord. Auxiliar instalado uma vez; sem nova autorização a cada preparação.
 */

// Original implementation. This is an investigation build, not a confirmed bypass.
const NAME = "CallShare";
const VERSION = "0.16.1";
const BACKEND_VERSION = "0.13.4";
const HELPER_VERSION = "0.16.0";
const PROJECT_FEED = 'https://raw.githubusercontent.com/matheus1g/CallShare/main/release.json';
const VIDEO_CODECS = new Set(["H264", "H265", "VP8", "VP9", "AV1", "AV1X"]);
const MEDIA_EVENTS = ["video-codec-error", "video-encoder-fallback", "video-decoder-fallback",
    "first-frame-encrypted-stats", "first-frame-stats", "mls-failure", "secure-frames-update"];
const GUARD = "2026-08-video-guard";
const ROOT = "callshare-toolbar";
const PANEL = "callshare-panel";
const REGIONS = ["automatic", "santiago", "us-east", "us-central", "us-west", "europe"];
const EVENTS = ["CONNECTION_OPEN", "CONNECTION_CLOSED", "VOICE_CHANNEL_SELECT",
    "STREAM_CREATE", "STREAM_UPDATE", "STREAM_DELETE", "STREAM_SERVER_UPDATE", "STREAM_STOP", "STREAM_CLOSE",
    "RTC_CONNECTION_STATE", "RTC_CONNECTION_VIDEO", "VOICE_SERVER_UPDATE"];
const STATES = new Set(["DISCONNECTED", "AWAITING_ENDPOINT", "AUTHENTICATING", "CONNECTING",
    "RTC_DISCONNECTED", "RTC_CONNECTING", "RTC_CONNECTED", "NO_ROUTE", "ICE_CHECKING", "DTLS_CONNECTING"]);
const KNOWN_REGIONS = new Set([...REGIONS.slice(1), "brazil", "rotterdam", "frankfurt", "southafrica",
    "hongkong", "singapore", "sydney", "japan", "india", "dubai", "stockholm", "russia",
    "bucharest", "seattle", "atlanta", "newark", "santa-clara", "south-korea", "finland"]);

module.exports = class CallShare {
    start() {
        this.generation = (this.generation || 0) + 1;
        this.running = true;
        this.setupState = null;
        this.setupCheckedAt = null;
        this.feed = releaseFeedUrl(BdApi.Data.load(NAME,'updateFeed') ?? PROJECT_FEED);
        this.feedCache = BdApi.Data.load(NAME,'updateCheck') || {};
        this.feedTask = null;
        this.packageJob=null;this.packageMessage='';this.releaseNoticeVersion=null;this.dismissReleaseNotice=null;
        if(BdApi.Data.load(NAME,'applyingVersion')===VERSION){
            BdApi.Data.save(NAME,'applyingVersion',null);
            this.toast('CallShare atualizado para '+VERSION+'.','success');
        }
        this.feedMessage = '';
        this.sessionRoute = null;
        this.routeStatus = "desligada";
        this.routeProgress=[];
        this.progressStartedAt=null;
        this.routeSessionReady = false;
        this.routeDisableBusy=false;
        this.voiceRouteReady=false;
        this.routeWarmReady=false;this.routeSwitchBusy=false;this.warmTask=null;
        this.autoPolicy=new AutoRoutePolicy({enabled:BdApi.Data.load(NAME,'autoEnabled')!==false});
        this.routeStrategy=BdApi.Data.load(NAME,'routeStrategy')==='continuous'?'continuous':'on-demand';
        this.manualDemandCall=null;
        this.bootstrapRestoreTask=null;
        const bootstrapGeneration=this.generation;
        this.bootstrap=new StreamBootstrap({
            context:()=>({call:this.voiceChannelId(),enabled:this.onDemandEnabled(),paused:this.autoPolicy.pausedCall===this.voiceChannelId(),
                ready:this.routeIsReady(),active:Boolean(this.sessionRoute&&!this.sessionRoute.standby),restoring:this.routeDisableBusy||this.routeSwitchBusy}),
            prepare:async()=>{
                await this.bootstrapRestoreTask;
                if(!this.running||this.generation!==bootstrapGeneration)return;
                const cycle=this.bootstrap.cycle;
                await this.ensureStandby();
                if(!this.running||this.generation!==bootstrapGeneration||this.bootstrap.cycle!==cycle||!cycle||!cycle.manual&&!cycle.requests.length)return;
                await this.activateSessionRoute();
            },
            restore:()=>this.bootstrapRestoreTask=this.suspendSessionRoute(),
            read:connection=>this.bootstrapMedia(connection),
            event:stage=>{this.record('início sob demanda',stage);this.updateToolbar();
                if(stage==='request-failed')this.toast('CallShare: o pedido de tela ao Discord falhou. A rota voltará à espera; copie o relatório.','warning');
                else if(['prepare-failed','normal-media-unconfirmed','restore-failed'].includes(stage))this.toast('CallShare: não foi possível confirmar a preparação ou a continuidade da tela. Confira o menu e copie o relatório.','warning');}
        });
        this.autoRecovery=false;this.recoveryCall=null;
        this.autoBusy=false;
        this.devMode=BdApi.Data.load(NAME,'devMode')===true;this.panelTab='general';
        this.lastAutoState=null;
        this.lastRouteFailure=null;
        this.providerProbe=null;this.lastExpiryWarning=null;
        this.providerMonitor=new ProviderMonitor({check:()=>this.probeProviderCertificate(),onResult:info=>{
            if(!this.running)return;
            this.record('certificado oficial do provedor',info.status);
            if(info.validated&&Date.parse(info.expiresAt)-Date.now()<86400000&&this.lastExpiryWarning!==info.fingerprint){
                this.lastExpiryWarning=info.fingerprint;this.toast('O certificado da VPN vence em menos de 24 horas. Você pode conferir a renovação em Validar certificado.','warning');
            }
            this.updateToolbar();
        }});
        this.routeMode='off';
        this.routeDiagnostics=new RouteDiagnostics();
        this.voicePreservation=null;
        this.mountTimer=null;
        this.lastRouteEvidence = this.sanitizeRouteEvidence(BdApi.Data.load(NAME, "lastRouteEvidence"));
        this.lastEndedRoute=this.sanitizeEndedRoute(BdApi.Data.load(NAME,'lastEndedRoute'));
        this.selectedStore = this.apexStore = this.userStore = this.mediaStore = null;
        this.streamStore = this.rtcStore = this.regionStore = this.gatewayTarget = null;
        this.streamRtcStore = this.statsStore = null;
        this.guard = this.dispatcher = this.readConfig = null;
        this.discoveryDelay = 3000;
        this.nextModuleScan = 0;
        this.discoveryCall = null;
        this.nativePatches = [];
        this.cleanups = [];
        this.pending = new Set();
        this.connectionHooks = new Map();
        this.mediaObservers = new Map();
        this.lastSampleTime = 0;
        this.videoTest = null;
        this.videoTestBusy = false;
        this.changedConfigs = new WeakMap();
        this.hits = 0;
        this.phase = "não marcada";
        this.nativeEnabled = BdApi.Data.load(NAME, "nativeEnabled") === true;
        this.region = "automatic"; // Region changes are never silently restored on startup.
        this.history = this.loadHistory();
        this.milestones = this.loadHistory("milestones", 80);
        this.refresh = () => {if(!this.running)return;this.syncConnectionHooks();this.tickAutomatic();this.updateToolbar();};
        BdApi.DOM.addStyle(NAME, `
            #${ROOT},#${PANEL}{font:14px/1.45 var(--font-primary,sans-serif);color:var(--text-subtle,var(--text-default,var(--text-normal)))}
            #${ROOT}{font-size:12px;position:fixed;bottom:12px;left:16px;z-index:1005;display:flex;align-items:center;gap:8px;padding:6px;border:1px solid var(--border-muted,var(--background-modifier-accent));background:var(--background-surface-high,var(--background-floating));border-radius:8px;box-shadow:var(--elevation-high)}
            #${ROOT}[data-mounted="true"]{position:relative;inset:auto;z-index:auto;margin:0 6px 4px;border:0;box-shadow:none;background:transparent;flex-shrink:0}
            #${ROOT}[hidden]{display:none}
            #${ROOT} button{white-space:nowrap}
            #${ROOT} .cs-menu{flex:0 0 auto}
            #${ROOT} .cs-route-shortcut{flex:1;min-width:0;text-align:left;font-weight:600}
            #${ROOT} .cs-route-shortcut:disabled{opacity:1;cursor:default;background:transparent;border-color:transparent;color:var(--text-subtle,var(--text-default))}
            #${ROOT} .cs-indicator{display:inline-block;width:14px;height:14px;min-width:14px;box-sizing:border-box;border:2px solid transparent;border-radius:50%;background:currentColor;color:var(--text-muted,var(--text-subtle))}
            #${ROOT} .cs-indicator[data-tone="ready"]{color:var(--status-positive,var(--text-positive))}
            #${ROOT} .cs-indicator[data-tone="working"]{color:var(--status-warning,var(--text-warning));background:transparent;border-color:currentColor transparent currentColor currentColor;animation:callshare-spin 1s linear infinite}
            #${ROOT} .cs-indicator[data-tone="attention"]{color:var(--status-danger,var(--text-danger))}
            @keyframes callshare-spin{to{transform:rotate(360deg)}}
            @media(prefers-reduced-motion:reduce){#${ROOT} .cs-indicator{animation:none}}
            #${PANEL}{box-sizing:border-box;position:fixed;bottom:100px;left:16px;z-index:1006;width:min(440px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;overflow-wrap:anywhere;padding:18px;border:1px solid var(--border-muted,var(--background-modifier-accent));border-radius:12px;background:var(--background-surface-high,var(--background-floating));box-shadow:var(--elevation-high)}
            #${PANEL} h2{font-size:18px;margin:0 0 12px} #${PANEL} h3{font-size:15px;margin:0} #${PANEL} p{margin:10px 0}
            #${PANEL} h2,#${PANEL} h3{color:var(--text-strong,var(--text-default,var(--text-normal)))}
            #${PANEL} label{display:flex;gap:8px;align-items:center;margin:12px 0}
            #${ROOT} button,#${PANEL} button{cursor:pointer;border:1px solid var(--border-muted,var(--background-modifier-accent));border-radius:6px;padding:8px 11px;background:var(--control-secondary-background-default,var(--button-secondary-background,var(--background-mod-subtle)));color:var(--control-secondary-text-default,var(--button-secondary-text,var(--text-default)));font:inherit}
            #${ROOT} button:hover:not(:disabled),#${PANEL} button:hover:not(:disabled){background:var(--control-secondary-background-hover,var(--button-secondary-background-hover,var(--background-mod-subtle)));color:var(--control-secondary-text-hover,var(--control-secondary-text-default,var(--text-default)))}
            #${ROOT} button:active:not(:disabled),#${PANEL} button:active:not(:disabled){background:var(--control-secondary-background-active,var(--control-secondary-background-hover));color:var(--control-secondary-text-active,var(--control-secondary-text-default))}
            #${PANEL} button:disabled{opacity:.45;cursor:default}
            #${PANEL} .cs-primary{background:var(--control-primary-background-default,var(--button-filled-brand-background,var(--brand-500)));color:var(--control-primary-text-default,var(--button-filled-brand-text,var(--white)));border-color:var(--control-primary-border-default,var(--border-muted))}
            #${PANEL} .cs-primary:hover:not(:disabled){background:var(--control-primary-background-hover,var(--button-filled-brand-background-hover,var(--brand-500)));color:var(--control-primary-text-hover,var(--control-primary-text-default))}
            #${PANEL} .cs-primary:active:not(:disabled){background:var(--control-primary-background-active,var(--control-primary-background-hover));color:var(--control-primary-text-active,var(--control-primary-text-default))}
            #${PANEL} .cs-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
            #${PANEL} .cs-status{padding:14px;border-radius:10px;background:var(--background-base-lower,var(--background-secondary,var(--background-surface-high)));border:1px solid var(--border-subtle,var(--border-muted));border-left:4px solid var(--text-muted);margin:12px 0}
            #${PANEL} .cs-status[data-tone="ready"]{border-left-color:var(--status-positive,var(--text-positive))}
            #${PANEL} .cs-status[data-tone="working"]{border-left-color:var(--status-warning,var(--text-warning))}
            #${PANEL} .cs-status[data-tone="attention"]{border-left-color:var(--status-danger,var(--text-danger))}
            #${PANEL} .cs-status p{margin-bottom:0} #${PANEL} .cs-close{float:right}
            #${PANEL} .cs-muted{color:var(--text-subtle,var(--text-muted));font-size:12px}
            #${PANEL} summary{cursor:pointer;padding:10px 0;font-weight:600;color:var(--text-default,var(--text-subtle))}
            #${PANEL} pre{white-space:pre-wrap;font-size:12px;user-select:text;color:var(--text-default,var(--text-subtle));background:var(--background-code,var(--background-base-lower));padding:10px;border-radius:6px;max-height:300px;overflow:auto}
            #${PANEL} button:focus-visible,#${ROOT} button:focus-visible{outline:2px solid var(--border-focus,var(--focus-primary,var(--brand-500)));outline-offset:2px}
            #${PANEL} .cs-progress{list-style:none;padding:10px 0 0;margin:12px 0 0;border-top:1px solid var(--border-subtle,var(--border-muted));font-size:12px;color:var(--text-muted,var(--text-subtle))}
            #${PANEL} .cs-progress li{display:grid;grid-template-columns:3.2em minmax(0,1fr);gap:8px;padding:4px 0}
            #${PANEL} .cs-progress li:last-child{color:var(--text-default,var(--text-subtle));font-weight:600}
            #${PANEL} .cs-progress-time{font-variant-numeric:tabular-nums}
            #${PANEL} [hidden]{display:none!important}
            #${ROOT} .cs-route-shortcut{overflow:hidden;text-overflow:ellipsis}
            #${ROOT} .cs-indicator[data-tone="ready"],#${ROOT} .cs-indicator[data-tone="attention"]{background:transparent;border:0}
            #${ROOT} .cs-indicator[data-tone="working"]{color:var(--text-link,var(--brand-500))}
            #${ROOT} .cs-indicator .cs-icon{display:block;width:14px;height:14px}
            #${ROOT} .cs-icon svg,#${PANEL} .cs-icon svg{display:block;width:100%;height:100%}
            #${PANEL} .cs-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none}
            #${PANEL} .cs-header{display:flex;align-items:center;gap:8px;padding-bottom:12px;border-bottom:1px solid var(--border-subtle,var(--border-muted))}
            #${PANEL} .cs-heading{display:flex;align-items:center;flex:1;flex-wrap:wrap;gap:6px;min-width:0}
            #${PANEL} .cs-heading h2{font-size:15px;margin:0}
            #${PANEL} .cs-version{font-size:11px;color:var(--text-subtle,var(--text-muted))}
            #${PANEL} .cs-logo{color:var(--text-link,var(--brand-500))}
            #${PANEL} .cs-header .cs-close{float:none;order:3}
            #${PANEL} .cs-tabs{display:flex;gap:4px;margin:12px 0}
            #${PANEL} .cs-tabs button{flex:1;border-color:transparent;background:transparent;color:var(--text-subtle,var(--text-muted));padding:7px 10px}
            #${PANEL} .cs-tabs button[aria-selected="true"]{background:var(--background-mod-subtle,var(--control-secondary-background-default));color:var(--text-strong,var(--text-default));border-color:var(--border-subtle,var(--border-muted))}
            #${PANEL}[data-mode="simple"]{padding:16px}
            #${PANEL}[data-mode="simple"] .cs-tabs{margin:8px 0}
            #${PANEL}[data-mode="simple"] .cs-tabs button{font-size:12px;padding:5px 8px}
            #${PANEL}[data-mode="simple"] .cs-status{display:flex;align-items:flex-start;gap:12px;margin:16px 0;padding:0;border:0;background:transparent}
            #${PANEL} .cs-status-icon{display:flex;align-items:center;justify-content:center;flex:none;width:42px;height:42px;border-radius:12px;color:var(--text-link,var(--brand-500));background:var(--background-mod-subtle,var(--control-secondary-background-default))}
            #${PANEL} .cs-status-icon .cs-icon{width:23px;height:23px}
            #${PANEL} .cs-status-body{min-width:0;flex:1}
            #${PANEL}[data-mode="simple"] .cs-status h3{font-size:15px;margin:0 0 4px}
            #${PANEL}[data-mode="simple"] .cs-status p{font-size:12px;margin:0;color:var(--text-subtle,var(--text-muted))}
            #${PANEL} .cs-status[data-tone="attention"] .cs-status-icon{color:var(--status-danger,var(--text-danger))}
            #${PANEL} .cs-summary{margin:12px 0;padding:9px 12px;border:1px solid var(--border-subtle,var(--border-muted));border-radius:12px;background:var(--background-base-lower,var(--background-secondary,var(--background-surface-high)))}
            #${PANEL} .cs-summary-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;font-size:12px}
            #${PANEL} .cs-summary-row dt{color:var(--text-subtle,var(--text-muted));min-width:0}
            #${PANEL} .cs-summary-row dd{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:0;margin:0;text-align:right;color:var(--text-strong,var(--text-default));font-weight:600}
            #${PANEL} .cs-summary-row dd[data-tone="ready"] .cs-icon{color:var(--status-positive,var(--text-positive))}
            #${PANEL} .cs-summary-row dd[data-tone="attention"] .cs-icon{color:var(--status-danger,var(--text-danger))}
            #${PANEL} .cs-summary-row dd[data-tone="working"] .cs-icon{color:var(--text-link,var(--brand-500))}
            #${PANEL} .cs-row-value{overflow-wrap:anywhere}
            #${PANEL}[data-mode="simple"] .cs-main-actions{display:flex;flex-direction:column;gap:6px;margin:12px 0}
            #${PANEL}[data-mode="simple"] .cs-main-actions .cs-primary{width:100%;min-height:44px;border-radius:10px;font-weight:600}
            #${PANEL} .cs-secondary-action{background:transparent;border-color:transparent;font-size:12px}
            #${PANEL} .cs-primary{background:var(--control-primary-background-default,var(--control-brand-background-default,var(--button-filled-brand-background,var(--brand-500))));color:var(--control-primary-text-default,var(--control-brand-text-default,var(--button-filled-brand-text,var(--white,hsl(0 0% 100%)))))}
            #${PANEL} .cs-primary:hover:not(:disabled){background:var(--control-primary-background-hover,var(--control-brand-background-hover,var(--button-filled-brand-background-hover,var(--brand-500))));color:var(--control-primary-text-hover,var(--control-brand-text-hover,var(--control-brand-text-default,var(--white,hsl(0 0% 100%)))))}
            #${PANEL} .cs-primary:active:not(:disabled){background:var(--control-primary-background-active,var(--control-brand-background-active,var(--control-brand-background-hover,var(--brand-500))));color:var(--control-primary-text-active,var(--control-brand-text-active,var(--control-brand-text-default,var(--white,hsl(0 0% 100%)))))}
            #${PANEL} .cs-status[data-tone="ready"] .cs-status-icon{color:var(--status-positive,var(--text-positive))}
            #${PANEL} .cs-automatic{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}
            #${PANEL} .cs-automatic input{order:2;width:17px;height:17px;accent-color:var(--brand-500)}
            #${PANEL} .cs-notice{margin:10px 0;padding:10px 12px;border-inline-start:3px solid var(--status-warning,var(--text-link));border-radius:6px;background:var(--background-mod-subtle,var(--background-secondary));font-size:13px}
            #${PANEL} .cs-notice p{margin:0 0 6px}
            #${PANEL} .cs-notice[hidden],#${PANEL} .cs-notice button[hidden]{display:none}
            #${PANEL} .cs-feed{box-sizing:border-box;width:100%;padding:7px;color:var(--text-default);background:var(--background-base-low,var(--background-secondary));border:1px solid var(--border-muted);border-radius:5px}
            #${PANEL} .cs-mode-footer button{margin-inline-start:auto}
            #${PANEL} .cs-mode-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border-subtle,var(--border-muted))}
            #${PANEL} .cs-mode-footer button{font-size:12px;padding:6px 9px}
            #${PANEL} .cs-mode-footer span{font-size:11px;color:var(--text-subtle,var(--text-muted))}
            #${PANEL} .cs-section-title{font-size:13px;margin:16px 0 8px}
            #${PANEL} .cs-advanced-options label{align-items:flex-start;font-size:12px}
            #${PANEL} .cs-spinner{animation:callshare-spin 1s linear infinite}
            @media(prefers-reduced-motion:reduce){#${PANEL} .cs-spinner{animation:none}}
            @media(max-width:380px){#${PANEL}[data-mode="simple"]{padding:12px}#${PANEL} .cs-header{gap:6px}#${PANEL} .cs-version{font-size:10px}#${PANEL} .cs-summary-row{gap:8px}}
        `);
        this.discover();
        if(this.routeStrategy==='on-demand'&&this.autoPolicy.enabled&&this.gatewayTarget)this.revealNativeControls();
        this.createToolbar();
        this.observeToolbarMount();
        this.timer = setInterval(() => {
            if (!this.running) return;
            this.discover();
            this.updateToolbar();
            if(this.sessionRoute || this.voiceChannelId() || this.streamConnections().length)this.captureRouteDiagnostics();
            this.tickAutomatic();
            if ((this.streamConnections().length || (this.sessionRoute && this.voiceChannelId())) && Date.now() - this.lastSampleTime >= 5000) {
                this.lastSampleTime = Date.now();
                this.record("amostra de mídia", this.mediaSummary() + " | " + this.voiceSummary());
            }
        }, 3000);
        this.record("plugin ativado");
        this.tickAutomatic();
        this.updateToolbar();
        this.toast(this.autoPolicy.enabled?(this.routeStrategy==='on-demand'?"CallShare: o túnel será preparado em espera ao entrar na call.":"CallShare automático: aguardando a voz conectar."):"CallShare pronto. O modo automático está disponível no menu.");
        const maintenanceTimer=setTimeout(()=>{
            this.pending.delete(maintenanceTimer);
            if(!this.running)return;
            this.checkInstallation(true);
            this.checkRelease();
        },1000);
        this.pending.add(maintenanceTimer);
    }

    stop() {
        this.generation++;
        this.closePanel({restoreFocus:false});
        this.providerMonitor?.cancel();this.providerProbe?.cancelProbe?.();this.providerProbe=null;
        this.bootstrap?.cancel();
        this.saveRouteEvidence();
        this.sessionRoute?.stop()?.catch?.(()=>{});
        this.sessionRoute = null;
        this.restoreVideoTest().catch(() => {});
        this.voiceRouteReady=false;
        this.record("plugin desativado");
        this.running = false;
        clearInterval(this.timer);
        clearTimeout(this.feedTimer);
        clearInterval(this.packageTimer);
        this.dismissReleaseNotice?.();this.dismissReleaseNotice=null;
        window.removeEventListener?.('focus',this.afterInstaller);
        clearTimeout(this.mountTimer);
        for (const timer of this.pending) clearTimeout(timer);
        this.pending.clear();
        this.selectedStore?.removeChangeListener?.(this.refresh);
        for (const undos of this.connectionHooks.values()) for (const undo of undos) { try { undo(); } catch {} }
        this.connectionHooks.clear();
        for (const observer of this.mediaObservers.values()) this.removeMediaObserver(observer);
        this.mediaObservers.clear();
        for (const cleanup of this.cleanups.splice(0)) { try { cleanup(); } catch {} }
        this.removeNativePatch();
        BdApi.Patcher.unpatchAll(NAME);
        this.notifyStores();
        document.getElementById(ROOT)?.remove();
        document.getElementById(PANEL)?.remove();
        BdApi.DOM.removeStyle(NAME);
    }

    loadHistory(key = "history", limit = 159) {
        const saved = BdApi.Data.load(NAME, key);
        if (!Array.isArray(saved)) return [];
        return saved.filter(row => typeof row === "string").slice(-limit).map(row => row.slice(0, 2400));
    }

    getStore(name) {
        try { return BdApi.Webpack.getStore(name); } catch { return undefined; }
    }

    getModule(filter) {
        try { return BdApi.Webpack.getModule(filter, {searchExports: true}); } catch { return undefined; }
    }

    discover() {
        const next = this.getStore("SelectedChannelStore");
        if (next && next !== this.selectedStore) {
            this.selectedStore?.removeChangeListener?.(this.refresh);
            this.selectedStore = next;
            next.addChangeListener?.(this.refresh);
        }
        this.apexStore ||= this.getStore("ApexExperimentStore");
        this.userStore ||= this.getStore("UserStore");
        this.mediaStore ||= this.getStore("MediaEngineStore");
        this.streamStore ||= this.getStore("ApplicationStreamingStore");
        this.rtcStore ||= this.getStore("RTCConnectionStore");
        this.streamRtcStore ||= this.getStore("StreamRTCConnectionStore");
        this.statsStore ||= this.getStore("MediaEngineStatsStore");
        if (!this.regionStore) this.attachRegionStore(this.getStore("RTCRegionStore"));
        const call = this.voiceChannelId();
        if (call !== this.discoveryCall) {
            this.discoveryCall = call;
            this.nextModuleScan = 0;
            this.discoveryDelay = 3000;
        }
        if (Date.now() >= this.nextModuleScan && (!this.guard || !this.dispatcher || !this.gatewayTarget)) {
            this.findMissingModules();
            this.nextModuleScan = Date.now() + this.discoveryDelay;
            this.discoveryDelay = Math.min(60000, this.discoveryDelay * 2);
        }
        this.applyNativePatch();
        this.syncConnectionHooks();
    }

    findMissingModules() {
        this.guard ||= this.getModule(m => m?.definition?.name === GUARD &&
            typeof m.getConfig === "function" && typeof m.useConfig === "function");
        if (!this.gatewayTarget) {
            const socket = this.getModule(m => typeof m?.streamCreate === "function" && typeof m?.streamWatch === "function");
            const socketClass = socket ? null : this.getModule(m => typeof m?.prototype?.streamCreate === "function" && typeof m?.prototype?.streamWatch === "function");
            this.attachGateway(socket || socketClass?.prototype);
        }
        if (!this.dispatcher) this.attachDispatcher(this.getModule(m =>
            typeof m?.dispatch === "function" && typeof m?.subscribe === "function" && typeof m?.unsubscribe === "function"));
    }

    attachRegionStore(store) {
        if (!store) return;
        const methods = ["getPreferredRegion", "getPreferredRegions", "shouldIncludePreferredRegion"];
        if (!methods.every(key => typeof store[key] === "function")) return;
        const undos = [];
        try {
            undos.push(BdApi.Patcher.after(NAME, store, methods[0], (_c, _a, result) =>
                this.region === "automatic" ? result : this.region));
            undos.push(BdApi.Patcher.after(NAME, store, methods[1], (_c, _a, result) =>
                this.region === "automatic" ? result : [this.region, ...(Array.isArray(result) ? result : []).filter(x => x !== this.region)]));
            undos.push(BdApi.Patcher.after(NAME, store, methods[2], (_c, _a, result) =>
                this.region === "automatic" ? result : true));
            if (undos.some(undo => typeof undo !== "function")) throw new Error("Unsupported patch");
            this.regionStore = store;
            this.cleanups.push(...undos);
        } catch { for (const undo of undos) { try { undo?.(); } catch {} } }
    }

    attachGateway(target) {
        if (!target) return;
        // Refuse an unrecognized implementation instead of guessing an argument slot.
        if (!Function.prototype.toString.call(target.streamCreate).includes("preferred_region")||
            !Function.prototype.toString.call(target.streamWatch).includes('stream_key')||typeof target.streamDelete!=='function') return;
        const undos = [];
        try {
            // In the inspected installed build, streamCreate(type,guild,channel,region)
            // sends preferred_region as its fourth argument. Never log its other args.
            undos.push(BdApi.Patcher.before(NAME, target, "streamCreate", (_c, args) => {
                if (this.region !== "automatic") args[3] = this.region;
                this.record("pedido nativo STREAM_CREATE");
            }));
            undos.push(BdApi.Patcher.before(NAME, target, "streamWatch", () => this.record("pedido nativo STREAM_WATCH")));
            // These inspected gateway methods return void. Keep that contract
            // while holding only the requested send until the route is ready.
            for(const [method,kind] of [['streamCreate','send'],['streamWatch','receive']]){
                undos.push(BdApi.Patcher.instead(NAME,target,method,(context,args,original)=>{
                    if(!this.onDemandEnabled()||!this.voiceChannelId()||this.autoPolicy.pausedCall===this.voiceChannelId())return original.apply(context,args);
                    const call=this.voiceChannelId(),generation=this.generation;
                    const key=kind==='receive'?args[0]:'own-stream';
                    const locate=()=>kind==='receive'?this.streamConnectionByKey(key):this.streamConnections().find(c=>c.isOwner===true);
                    // BetterDiscord supplies an unbound continuation. Preserve
                    // the native gateway receiver, including after the wait.
                    this.bootstrap.request({kind,key,locate,forward:()=>original.apply(context,args),
                        valid:()=>this.running&&this.generation===generation&&this.voiceChannelId()===call&&context.isSessionEstablished?.()!==false});
                }));
            }
            if(typeof target.streamDelete==='function')undos.push(BdApi.Patcher.before(NAME,target,'streamDelete',(_c,args)=>{
                this.cancelBootstrapRequest(args[0]);
            }));
            if (undos.some(undo => typeof undo !== "function")) throw new Error("Unsupported patch");
            this.gatewayTarget = target;
            this.cleanups.push(...undos);
        } catch { for (const undo of undos) { try { undo?.(); } catch {} } }
    }

    cancelBootstrapRequest(key) {
        let own=key==null;
        try{const id=this.userStore?.getCurrentUser?.()?.id;if(typeof id==='string'&&typeof key==='string')own=key.endsWith(':'+id);}catch{}
        this.bootstrap?.cancelRequest(key,{send:own});
    }

    attachDispatcher(dispatcher) {
        if (!dispatcher) return;
        this.dispatcher = dispatcher;
        for (const event of EVENTS) {
            const listener = payload => {
                if(['STREAM_STOP','STREAM_CLOSE','STREAM_DELETE'].includes(event))this.cancelBootstrapRequest(payload?.streamKey);
                // Capture the event's state now: the store can advance again before a timer fires.
                const detail = this.eventDetail(event, payload);
                const timer = setTimeout(() => {
                    this.pending.delete(timer);
                    if (this.running) {
                        if (event === "CONNECTION_CLOSED") this.routeSessionReady = false;
                        if (event === "CONNECTION_OPEN" && this.sessionRoute?.routed > 0) {
                            this.routeSessionReady = true;
                            this.saveRouteEvidence();
                            this.record("nova sessão aberta pela VPN integrada");
                            this.updateRouteStatus("Conexão pronta. Entre na call e teste o compartilhamento nativo.");
                        }
                        this.syncConnectionHooks();
                        this.tickAutomatic();
                        this.record(event, detail);
                    }
                }, 0);
                this.pending.add(timer);
            };
            try {
                dispatcher.subscribe(event, listener);
                this.cleanups.push(() => dispatcher.unsubscribe(event, listener));
            } catch { /* Event availability varies across builds. */ }
        }
    }

    applyNativePatch() {
        if (!this.nativeEnabled || this.nativePatches.length || !this.guard || !this.running) return;
        this.readConfig = this.guard.getConfig.bind(this.guard);
        try {
            for (const key of ["getConfig", "useConfig"]) {
                const undo = BdApi.Patcher.after(NAME, this.guard, key, (_c, _args, result) => {
                    if (!result || typeof result !== "object" || result.videoEnabled !== false) return;
                    this.hits++;
                    // Stable references matter for React hooks. Never mutate the result.
                    if (!this.changedConfigs.has(result)) this.changedConfigs.set(result, {...result, videoEnabled: true});
                    return this.changedConfigs.get(result);
                });
                if (typeof undo !== "function") throw new Error("Unsupported patch");
                this.nativePatches.push(undo);
            }
            this.notifyStores();
        } catch {
            this.removeNativePatch();
            this.toast("Não foi possível instalar o teste visual nesta versão.", "warning");
        }
    }

    removeNativePatch() {
        for (const undo of this.nativePatches.splice(0)) { try { undo(); } catch {} }
        this.notifyStores();
    }

    notifyStores() {
        for (const store of [this.apexStore, this.mediaStore]) { try { store?.emitChange?.(); } catch {} }
    }

    voiceChannelId() {
        try { return this.selectedStore?.getVoiceChannelId?.() || null; } catch { return null; }
    }

    safeState(value) { return STATES.has(value) ? value : "desconhecido"; }

    safeRegion(value) {
        if (KNOWN_REGIONS.has(value)) return value;
        if (typeof value !== "string") return "desconhecida";
        // Extract only a known region from Discord-owned media hostnames, never an address.
        const match = /^(?:wss?:\/\/)?([a-z-]+)\d+\.discord\.(?:media|gg)(?::\d+)?\/?$/.exec(value);
        return match && KNOWN_REGIONS.has(match[1]) ? match[1] : "desconhecida";
    }

    eventDetail(event, payload) {
        const parts = [];
        const code = [payload?.code, payload?.closeCode, payload?.errorCode]
            .find(value => Number.isInteger(value) && value >= 0 && value <= 65535);
        if (code !== undefined) parts.push(`código=${code}`);
        if (event === "RTC_CONNECTION_STATE") {
            parts.push(`estado=${this.safeState(payload?.state)}`);
            parts.push(`tipo=${payload?.streamKey ? "stream" : "voz"}`);
            if (typeof payload?.willReconnect === "boolean") parts.push(`reconectará=${payload.willReconnect}`);
        }
        if (["STREAM_CREATE", "STREAM_SERVER_UPDATE", "VOICE_SERVER_UPDATE", "RTC_CONNECTION_STATE"].includes(event)) {
            const region = this.safeRegion(payload?.region || payload?.endpoint || payload?.hostname);
            if (region !== "desconhecida") parts.push(`região efetiva=${region}`);
        }
        if (["STREAM_CREATE", "STREAM_UPDATE"].includes(event)) {
            if (Array.isArray(payload?.viewerIds)) parts.push(`espectadores=${payload.viewerIds.length}`);
            if (typeof payload?.paused === "boolean") parts.push(`pausada=${payload.paused}`);
        }
        return parts.join("; ");
    }

    streamConnections() {
        try {
            const all = this.streamRtcStore?.getRTCConnections?.();
            if (!all || typeof all !== "object") return [];
            return (typeof all.values === "function" ? Array.from(all.values()) : Object.values(all))
                .filter(connection => connection && typeof connection === "object").slice(0, 6);
        } catch { return []; }
    }

    streamConnectionByKey(key) {
        try{const all=this.streamRtcStore?.getRTCConnections?.();return this.streamRtcStore?.getRTCConnection?.(key)||all?.get?.(key)||all?.[key]||null;}catch{return null;}
    }

    bootstrapMedia(connection) {
        if(!connection)return null;
        const row=this.observeRouteConnection(connection),stats=this.connectionStats(connection),role=row?.role;
        let items=role==='receive'?stats?.rtp?.inbound:stats?.rtp?.outbound;
        if(items&&!Array.isArray(items))items=Object.values(items).flat();
        const sum=key=>{const values=(Array.isArray(items)?items:[]).filter(i=>i?.type==='video'&&Number.isSafeInteger(i[key])&&i[key]>=0);return values.length?values.reduce((n,i)=>n+i[key],0):null;};
        let wanted=false;try{wanted=connection.hasActiveRemoteWants?.()===true;}catch{}
        return {id:row?.id,role,state:this.safeState(connection.state),frames:sum(role==='receive'?'framesDecoded':'framesEncoded'),
            bytes:sum(role==='receive'?'bytesReceived':'bytesSent'),wanted,ping:stats?.transport?.ping};
    }

    syncConnectionHooks() {
        const active = new Set(this.streamConnections());
        try { const voice = this.rtcStore?.getRTCConnection?.(); if (voice) active.add(voice); } catch {}
        this.syncMediaObservers(active);
        for (const [connection, undos] of this.connectionHooks) if (!active.has(connection)) {
            for (const undo of undos) { try { undo(); } catch {} }
            this.connectionHooks.delete(connection);
        }
        for (const connection of active) {
            this.observeRouteConnection(connection);
            if (this.connectionHooks.has(connection)) continue;
            const undos = [];
            const hookGeneration=this.generation;
            for (const key of ["_handleConnecting", "_handleConnect", "_handleReady", "_handleSfuUpdate", "_handleSelectProtocolAck", "_handleDisconnect"]) {
                if (typeof connection[key] !== "function") continue;
                try {
                    const undo = BdApi.Patcher.before(NAME, connection, key, (_context, args) => {
                        if (!this.running||this.generation!==hookGeneration) return;
                        const role = this.connectionRole(connection);
                        if(role==='voz'&&key==='_handleConnecting'&&this.voicePreservation){
                            if(this.voicePreservation.channel===this.voiceChannelId()){this.autoRecovery=true;this.recoveryCall=this.voiceChannelId();}
                            this.voicePreservation=null;
                            this.record('voz reconectando; encerrando rota anterior');
                            this.disableSessionRoute({reason:'voice-changed'});
                        }
                        let endpoint=null;
                        // Installed Discord binds socket first: READY(socket,ip,port,...), SFU(socket,{primary}).
                        // Ignore stale sockets and project only the IP/port; never retain any other args.
                        const currentSocket=connection._socket && args[0]===connection._socket;
                        if(key==='_handleReady')endpoint=currentSocket?routeEndpoint(args[1],args[2]):args.length===1?routeEndpoint(args[0]?.ip,args[0]?.port):null;
                        if(key==='_handleSfuUpdate'&&currentSocket)endpoint=args[1]?.primary?routeEndpoint(args[1].primary.ip,args[1].primary.port):{clear:true};
                        this.observeRouteConnection(connection,endpoint,key==='_handleReady'?'ready':key==='_handleSfuUpdate'?'sfu':key==='_handleDisconnect'?'disconnect':'connect');
                        this.checkVoicePreservation();
                        if (key === "_handleDisconnect") {
                            const code = Number.isInteger(args[2]) && args[2] >= 0 && args[2] <= 65535 ? args[2] : "?";
                            // Reasons can contain identifiers. Emit only a fixed category.
                            const reason = typeof args[3] === "string" && /geo|country|region|location/i.test(args[3])
                                ? "menciona geografia" : "não classificado";
                            const clean = typeof args[1] === "boolean" ? args[1] : "?";
                            this.record("RTC socket encerrado", `tipo=${role}; código=${code}; limpo=${clean}; motivo=${reason}`);
                        } else {
                            const stage = {_handleConnecting: "socket iniciando", _handleConnect: "socket conectado",
                                _handleReady: "READY recebido", _handleSfuUpdate: "SFU atualizado",
                                _handleSelectProtocolAck: "protocolo de mídia aceito"}[key];
                            this.record(`RTC ${stage}`, `tipo=${role}; controle=${this.controlRoute(connection)}`);
                        }
                    });
                    if (typeof undo === "function") undos.push(undo);
                } catch { /* Missing hooks stay visible in the report as a count of zero. */ }
            }
            this.connectionHooks.set(connection, undos);
        }
        const live=new Set();for(const connection of active){const row=this.observeRouteConnection(connection);if(row)live.add(row.id);}
        this.routeDiagnostics?.reconcile(live);
        this.checkVoicePreservation();
    }

    observeRouteConnection(connection,payload,stage='snapshot') {
        const role={voz:'voice',envio:'send','recepção':'receive'}[this.connectionRole(connection)];
        return this.routeDiagnostics?.observe(connection,role,this.safeState(connection.state),payload,stage);
    }

    captureRouteDiagnostics() {
        const before=this.sessionRoute?.lastStatus?.networkBefore;
        if(before&&!this.routeDiagnostics.native.some(r=>r.at===before.at))this.routeDiagnostics?.captureNative(before);
        const network=this.sessionRoute?.lastStatus?.network;
        this.routeDiagnostics?.captureNative(network);
        this.routeDiagnostics?.captureNative(this.sessionRoute?.lastStatus?.networkAfter);
        let ping=null,voiceStats=null;try{const c=this.rtcStore?.getRTCConnection?.();voiceStats=this.connectionStats(c);ping=c?.getLastPing?.()??voiceStats?.transport?.ping??null;}catch{}
        const streams=this.streamConnections().map(c=>{const row=this.observeRouteConnection(c),stats=this.connectionStats(c);
            const sum=(items,key)=>{const values=Array.isArray(items)?items.filter(i=>i?.type==='video'&&Number.isSafeInteger(i[key])&&i[key]>=0):[];return values.length?values.reduce((n,i)=>n+i[key],0):null;};
            const inbound=stats?.rtp?.inbound,items=Array.isArray(inbound)?inbound:inbound&&Object.values(inbound).flat();
            return {id:row?.id,stats,framesEncoded:sum(stats?.rtp?.outbound,'framesEncoded'),framesDecoded:sum(items,'framesDecoded')};});
        this.routeDiagnostics?.sample(ping,streams,voiceStats);
    }

    checkVoicePreservation() {
        const saved=this.voicePreservation;if(!saved||!this.sessionRoute||this.routeDisableBusy)return;
        const rows=this.routeDiagnostics?.connections||[],voice=rows.find(r=>r.id===saved.id&&r.active);
        const changed=!this.voiceChannelId()||this.voiceChannelId()!==saved.channel||!voice||voice.state!=='RTC_CONNECTED'||voice.protocol!=='udp'||voice.media?.ip!==saved.voice.ip||voice.media?.port!==saved.voice.port;
        const overlap=rows.some(r=>r.active&&r.role!=='voice'&&r.media?.ip===saved.voice.ip&&r.media?.port===saved.voice.port);
        if(!changed&&!overlap)return;
        if(!overlap&&saved.channel===this.voiceChannelId()){this.autoRecovery=true;this.recoveryCall=saved.channel;}
        this.voicePreservation=null;
        this.routeDiagnostics.event(overlap?'endpoint-overlap':'voice-changed',saved.id);
        if(overlap||!this.autoPolicy?.enabled)this.toast(overlap?"Voz e transmissão usam o mesmo destino. Voltando à conexão normal.":"A conexão da voz mudou. Voltando à conexão normal.",'warning');
        this.disableSessionRoute({reason:overlap?'endpoint-overlap':'voice-changed'});
    }

    automaticContext() {
        const call=this.voiceChannelId();
        if(this.recoveryCall&&this.recoveryCall!==call){this.autoRecovery=false;this.recoveryCall=null;}
        const plan=this.routeDiagnostics.plan({allowStreams:this.autoRecovery||this.routeStrategy==='on-demand',allowPendingStreams:this.routeStrategy==='on-demand'});
        return {call,eligible:plan.eligible,streams:plan.reason==='stream-already-active',
            key:plan.eligible?`${call}|${plan.id}|${plan.voice.ip}:${plan.voice.port}`:null,
            hasRoute:Boolean(this.sessionRoute),ready:this.routeIsReady()||this.standbyIsReady(),
            restoring:this.routeDisableBusy||this.routeSwitchBusy||Boolean(this.sessionRoute?.stopped&&!this.sessionRoute?.cleanupConfirmed),busy:this.autoBusy||Boolean(this.warmTask)||this.bootstrap.pending};
    }

    tickAutomatic() {
        if(!this.running||!this.autoPolicy||this.packageJob)return;
        if(this.manualDemandCall&&this.manualDemandCall!==this.voiceChannelId())this.manualDemandCall=null;
        if(this.routeStrategy==='on-demand'){this.bootstrap.tick();this.updateToolbar();}
        if(this.sessionRoute?.stopped&&this.sessionRoute.cleanupConfirmed&&!this.routeDisableBusy){
            const endedCode=SessionClient.terminalCode(this.sessionRoute.terminalFailure)||'CS_AUTO_ROUTE_ENDED';
            this.lastEndedRoute=this.sanitizeEndedRoute({at:Date.now(),failure:endedCode,evidence:this.sessionRoute.evidence?.()});
            BdApi.Data.save(NAME,'lastEndedRoute',this.lastEndedRoute);
            if(this.routeMode==='voice-direct'&&this.voiceRouteReady){this.autoRecovery=true;this.recoveryCall=this.voiceChannelId();}
            this.saveRouteEvidence();this.captureRouteDiagnostics();this.sessionRoute=null;this.voicePreservation=null;
            this.voiceRouteReady=false;this.routeMode='off';
            this.routeWarmReady=false;
            this.autoPolicy.fail(endedCode);this.record('rota encerrada pelo auxiliar; recuperação agendada',endedCode);
        }
        const action=this.autoPolicy.tick(this.automaticContext());
        if(this.autoPolicy.state!==this.lastAutoState){this.lastAutoState=this.autoPolicy.state;this.record('automático',this.lastAutoState);this.updateToolbar();}
        if(action!=='prepare-voice'||this.autoBusy)return;
        const generation=this.generation,call=this.voiceChannelId();
        this.autoBusy=true;
        this.routeDiagnostics.event('auto-start');
        const standby=this.routeStrategy==='on-demand';
        const preparation=this.enableSessionRoute(true,{automatic:true,allowStreams:this.autoRecovery||standby,standby}),ownedRoute=this.sessionRoute;
        if(standby)this.warmTask=preparation;
        preparation.then(()=>{
            if(!this.running||this.generation!==generation)return;
            this.autoPolicy.settled();
            if(call!==this.voiceChannelId()||this.autoPolicy.pausedCall===call||!this.autoPolicy.enabled||ownedRoute?.callshareCancelled||this.sessionRoute&&this.sessionRoute!==ownedRoute)return;
            if((this.voiceRouteReady||this.routeWarmReady)&&this.sessionRoute===ownedRoute&&!this.sessionRoute.stopped){this.autoPolicy.succeeded();this.autoRecovery=false;this.recoveryCall=null;this.routeDiagnostics.event('auto-ready');return;}
            this.autoPolicy.fail(this.lastRouteFailure||'CS_AUTO_PREPARE');this.routeDiagnostics.event('auto-fail');
        }).catch(()=>{if(this.running&&this.generation===generation)this.autoPolicy.fail('CS_AUTO_PREPARE');})
        .finally(()=>{if(this.running&&this.generation===generation){if(this.warmTask===preparation)this.warmTask=null;this.autoBusy=false;this.tickAutomatic();this.updateToolbar();}});
    }

    setAutomatic(value) {
        if(!value){this.bootstrap?.cancel();this.manualDemandCall=null;}
        this.autoPolicy.enable(value);BdApi.Data.save(NAME,'autoEnabled',this.autoPolicy.enabled);
        if(value&&this.routeStrategy==='on-demand')this.revealNativeControls();
        this.record('modo automático '+(this.autoPolicy.enabled?'ativado':'desativado'));
        this.tickAutomatic();this.updateToolbar();
    }

    resumeAutomatic() {this.autoPolicy.resume();this.record('automático retomado manualmente');this.tickAutomatic();this.updateToolbar();}

    async setRouteStrategy(value) {
        this.bootstrap.cancel();this.manualDemandCall=null;this.routeStrategy=value==='continuous'?'continuous':'on-demand';
        BdApi.Data.save(NAME,'routeStrategy',this.routeStrategy);
        await this.disableSessionRoute({reason:'strategy-change'});this.autoPolicy.resume();
        if(this.routeStrategy==='on-demand'&&this.autoPolicy.enabled)this.revealNativeControls();
        this.record('estratégia de conexão',this.routeStrategy);this.tickAutomatic();this.updateToolbar();
    }

    async forceReconnect() {
        if(!this.voiceChannelId())return this.toast('Entre em uma call para conectar o CallShare.');
        if(this.routeStrategy==='on-demand'){
            this.manualDemandCall=this.voiceChannelId();
            this.autoPolicy.resume();
            if(this.routeDisableBusy||this.routeSwitchBusy||this.sessionRoute&&!this.sessionRoute.stopped&&!this.sessionRoute.standby)return;
            await this.ensureStandby({automatic:false});
            this.updateToolbar();return;
        }
        this.tickAutomatic();
        if(this.autoBusy||this.routeDisableBusy)return;
        if(this.sessionRoute&&!this.sessionRoute.stopped)return;
        this.autoPolicy.resume();this.updateToolbar();
        await this.enableSessionRoute(true,{allowStreams:true});
        if(this.running&&!this.voiceRouteReady&&this.lastRouteFailure&&this.autoPolicy.enabled)this.autoPolicy.fail(this.lastRouteFailure);
        this.tickAutomatic();this.updateToolbar();
    }

    onDemandEnabled() {return this.routeStrategy==='on-demand'&&Boolean(this.autoPolicy?.enabled||this.manualDemandCall&&this.manualDemandCall===this.voiceChannelId());}

    async probeProviderCertificate() {
        const probe=this.newSessionTransport(()=>{});this.providerProbe=probe;
        try{return await probe.probeProvider();}finally{if(this.providerProbe===probe)this.providerProbe=null;}
    }

    validateProviderCertificate() {
        if(!this.running||!this.providerMonitor)return;
        const busy=this.autoBusy||Boolean(this.warmTask)||this.routeDisableBusy||this.routeSwitchBusy||this.bootstrap.pending;
        const task=this.providerMonitor.validate({busy});if(task)this.updateToolbar();return task;
    }

    async ensureStandby({automatic=true}={}) {
        if(this.warmTask){await this.warmTask;return;}
        if(this.sessionRoute)return;
        const generation=this.generation;
        const task=this.enableSessionRoute(true,{automatic,allowStreams:true,standby:true});this.warmTask=task;
        try{
            await task;
            if(this.running&&this.generation===generation&&!this.routeWarmReady&&this.lastRouteFailure&&this.autoPolicy.enabled)this.autoPolicy.fail(this.lastRouteFailure);
        }finally{if(this.warmTask===task)this.warmTask=null;}
    }

    async activateSessionRoute() {
        if(this.routeIsReady())return true;
        const route=this.sessionRoute,generation=this.generation;
        if(!this.standbyIsReady()||this.routeSwitchBusy)throw Error('route-not-ready');
        this.routeSwitchBusy=true;this.routeWarmReady=false;
        this.updateRouteStatus('ativando o encaminhamento do Discord pelo túnel em espera');
        try{
            await route.setRouting(true);
            if(!this.running||this.generation!==generation||this.sessionRoute!==route)return false;
            this.syncConnectionHooks();if(!this.voicePreservation)throw Error('voice-changed');
            route.installWebSocket(window);this.voiceRouteReady=true;this.routeMode='voice-direct';
            this.updateRouteStatus('encaminhamento temporário ativo; aguardando a mídia');return true;
        }catch{if(this.sessionRoute===route)await this.disableSessionRoute({reason:'switch-failed'});return false;}
        finally{if(this.generation===generation){this.routeSwitchBusy=false;this.updateToolbar();}}
    }

    async suspendSessionRoute() {
        const route=this.sessionRoute,generation=this.generation;
        if(!route)return true;
        if(this.routeDisableBusy||this.routeSwitchBusy)return false;
        this.routeSwitchBusy=true;this.voiceRouteReady=false;this.routeWarmReady=false;
        this.updateRouteStatus('voltando o Discord à conexão normal; mantendo o túnel em espera');
        try{
            await route.setRouting(false);
            if(!this.running||this.generation!==generation||this.sessionRoute!==route)return false;
            this.routeWarmReady=true;this.routeMode='standby';this.phase='conexão normal com túnel em espera';
            this.captureRouteDiagnostics();this.saveRouteEvidence();this.updateRouteStatus('Discord na conexão normal; túnel em espera confirmado');return true;
        }catch{if(this.sessionRoute===route)await this.disableSessionRoute({reason:'switch-failed'});return false;}
        finally{if(this.generation===generation){this.routeSwitchBusy=false;this.tickAutomatic();this.updateToolbar();}}
    }

    revealNativeControls() {
        this.nativeEnabled=true;try{BdApi.Data.save(NAME,'nativeEnabled',true);}catch{}this.applyNativePatch();
    }

    connectionRole(connection) {
        try {
            if (connection.isOwner === true) return "envio";
            if (connection.isOwner === false) return "recepção";
        } catch {}
        return "voz";
    }

    safeCodec(value) { return VIDEO_CODECS.has(value) ? value : "não identificado"; }

    removeMediaObserver(observer) {
        for (const undo of observer.undos) { try { undo(); } catch {} }
    }

    syncMediaObservers(connections) {
        const natives = new Set();
        for (const connection of connections) {
            const native = connection?._connection;
            if (!native || native.destroyed) continue;
            natives.add(native);
            if (this.mediaObservers.has(native)) continue;
            const observer = {undos: [], counts: Object.create(null)};
            this.mediaObservers.set(native, observer);
            // These are the inspected JS emitter events, not replacement native callbacks.
            // Registering listeners leaves Discord's own codec/encryption callbacks intact.
            if (typeof native.on !== "function" || typeof native.removeListener !== "function") continue;
            for (const event of MEDIA_EVENTS) {
                const listener = () => {
                    if (!this.running) return;
                    const count = observer.counts[event] = Math.min(1000000, (observer.counts[event] || 0) + 1);
                    // Ignore all payloads: even first-frame and MLS events can contain IDs/keys.
                    if (count === 1) this.record("evento do motor nativo", `tipo=${this.connectionRole(connection)}; evento=${event}`);
                };
                try {
                    native.on(event, listener);
                    observer.undos.push(() => native.removeListener(event, listener));
                } catch { /* Coverage remains explicit in the report. */ }
            }
        }
        for (const [native, observer] of this.mediaObservers) if (!natives.has(native)) {
            this.removeMediaObserver(observer); this.mediaObservers.delete(native);
        }
    }

    negotiationSummary(connection) {
        const native = connection?._connection;
        if (!native) return "motor indisponível";
        const flag = value => typeof value === "boolean" ? String(value) : "?";
        const protocol = ["udp", "tcp", "webrtc"].includes(connection.protocol) ? connection.protocol : "não identificado";
        const stamp = value => value === null ? false : Number.isFinite(value) && value >= 0 ? true : "?";
        const sent = stamp(connection._selectProtocolSentAt), ack = stamp(connection._selectProtocolAckAt);
        const port = Number.isInteger(connection.port) && connection.port >= 1 && connection.port <= 65535 ? connection.port : "?";
        let dave = "?";
        try {
            const version = connection.getSecureFramesState?.()?.version;
            if (Number.isInteger(version) && version >= 0 && version <= 65535) dave = String(version);
        } catch {}
        const capabilities = Array.isArray(native.codecs) ? native.codecs.filter(c => c?.type === "video" && VIDEO_CODECS.has(c.name)).slice(0, 8)
            .map(c => `${c.name}:codifica=${flag(c.encode)},decodifica=${flag(c.decode)}`).join(" / ") : "";
        const observer = this.mediaObservers.get(native);
        const events = MEDIA_EVENTS.map(event => `${event}=${observer?.counts[event] || 0}`).join(",");
        return `protocolo=${protocol}; seleção enviada=${sent}; seleção confirmada=${ack}; porta de mídia=${port}; codecs negociados=${flag(connection._hasCodecs)}; codec de vídeo=${this.safeCodec(native.currentVideoCodec)}; DAVE versão=${dave}; capacidades[${capabilities || "sem amostra"}]; observadores=${observer?.undos.length || 0}/${MEDIA_EVENTS.length}; eventos após observação[${events}]`;
    }

    nativeVideoSummary(connection) {
        const native = connection?._connection;
        if (!native) return "motor nativo indisponível";
        const flag = value => typeof value === "boolean" ? value : "?";
        let source = "?", layers = "?";
        try { source = flag(native.hasDesktopSource?.()); } catch {}
        try {
            const params = native.getStreamParameters?.();
            if (Array.isArray(params)) layers = `${params.filter(layer => layer?.active === true).length}/${params.length}`;
        } catch {}
        return `motor vídeo=${flag(native.videoSupported)}; fonte selecionada=${source}; envio ligado=${flag(native.selfVideo)}; camadas ativas=${layers}`;
    }

    async reactivateVideo() {
        if (this.videoTestBusy || this.videoTest) {
            this.toast("Já há um teste aplicado ou em andamento. Use Desfazer teste antes de repetir.", "warning");
            return false;
        }
        const owners = this.streamConnections().filter(connection => connection.isOwner === true);
        if (!this.running || owners.length !== 1 || owners[0].state !== "RTC_CONNECTED") {
            this.toast("Inicie uma transmissão nativa e mantenha sua conexão aberta antes do teste.", "warning");
            return false;
        }
        const connection = owners[0], native = connection._connection;
        const required = ["getStreamParameters", "setStreamParameters", "setVideoBroadcast", "applyVideoTransportOptions", "hasDesktopSource"];
        if (!native || native.destroyed || native.videoSupported !== true ||
            typeof native.selfVideo !== "boolean" || !required.every(key => typeof native[key] === "function")) {
            this.record("reativação recusada", this.nativeVideoSummary(connection));
            this.toast("O motor não expôs os controles necessários ou não anuncia suporte a vídeo. Copie o relatório.", "warning");
            return false;
        }
        if (native.hasDesktopSource() !== true || connection.hasActiveRemoteWants?.() !== true) {
            this.toast("Escolha uma tela no compartilhamento nativo e peça ao espectador para entrar antes do teste.", "warning");
            return false;
        }
        const current = native.getStreamParameters();
        if (!Array.isArray(current) || !current.length || current.some(layer => !layer || typeof layer.rid !== "string")) {
            this.toast("As camadas de vídeo não têm o formato esperado. Nenhuma alteração foi aplicada.", "warning");
            return false;
        }
        let primary = current.findIndex(layer => layer.quality === 100 && ["video", "screen"].includes(layer.type));
        if (primary < 0 && current.length === 1 && ["video", "screen"].includes(current[0].type)) primary = 0;
        if (primary < 0) {
            this.toast("Não foi possível identificar a camada principal de vídeo.", "warning");
            return false;
        }
        const next = current.map((layer, index) => index === primary ? {...layer, active: true} : {...layer});
        const backup = {connection, native, selfVideo: native.selfVideo,
            layers: current.map(layer => ({rid: layer.rid, active: layer.active}))};
        const generation = this.generation;
        this.videoTest = backup;
        this.videoTestBusy = true;
        this.record("antes da reativação local", this.nativeVideoSummary(connection) + " | " + this.mediaSummary());
        try {
            // Keep the existing source, RTP identifiers, codecs, audio and encryption.
            // Only activate the primary layer the existing viewer is requesting.
            await native.setStreamParameters(next);
            if (!this.running || this.generation !== generation || native.destroyed) {
                await this.restoreVideoTest(backup);
                return false;
            }
            native.setVideoBroadcast(true);
            native.applyVideoTransportOptions();
            this.record("teste de reativação aplicado", this.nativeVideoSummary(connection) + " | " + this.mediaSummary());
            this.toast("Teste aplicado. Aguarde 15 segundos e confirme se a imagem chegou ao espectador.");
            this.showPanel();
            return true;
        } catch {
            await this.restoreVideoTest(backup).catch(() => {});
            if (this.running && this.generation === generation) {
                this.record("teste de reativação falhou");
                this.toast("O motor recusou a alteração. O estado anterior foi solicitado novamente; copie o relatório.", "error");
            }
            return false;
        } finally {
            if (this.generation === generation) this.videoTestBusy = false;
        }
    }

    async restoreVideoTest(backup = this.videoTest) {
        if (!backup) return;
        const {native, connection} = backup;
        if (native.destroyed || connection._connection !== native) {
            if (this.videoTest === backup) this.videoTest = null;
            return;
        }
        // Read current parameters so a later quality adjustment is not overwritten.
        const current = native.getStreamParameters();
        if (!Array.isArray(current)) throw new Error("Stream parameters unavailable");
        const restored = current.map(layer => {
            const previous = backup.layers.find(item => item.rid === layer.rid);
            return previous ? {...layer, active: previous.active} : {...layer};
        });
        if (native.selfVideo === true) native.setVideoBroadcast(backup.selfVideo);
        const result = native.setStreamParameters(restored);
        native.applyVideoTransportOptions();
        await result;
        if (this.videoTest === backup) this.videoTest = null;
        if (this.running) this.record("teste local desfeito", this.nativeVideoSummary(connection));
    }

    videoCounters(items) {
        if (!Array.isArray(items)) return "indisponível";
        const video = items.filter(item => item?.type === "video");
        if (!video.length) return "sem amostra de vídeo";
        const output = [];
        for (const key of ["bytesSent", "bytesReceived", "packetsSent", "packetsReceived", "framesEncoded", "framesDecoded", "frameRateInput", "frameRateEncode", "frameRateDecode", "frameRateRender", "screenshareCapturedFps", "bitrate", "bitrateTarget", "framesDroppedRateLimiter", "framesDroppedEncoderQueue", "framesDroppedCongestionWindow", "framesDroppedEncoder", "averageEncodeTime", "encryptSuccessCount", "encryptFailureCount", "encryptMissingKeyCount"]) {
            const values = video.map(item => item[key]).filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
            if (!values.length) continue;
            const result = /Rate|Fps|Time/.test(key) ? Math.max(...values) : values.reduce((sum, value) => sum + value, 0);
            output.push(`${key}=${Math.round(result * 100) / 100}`);
        }
        return output.join(",") || "amostra sem contadores conhecidos";
    }

    connectionStats(connection) {
        try { const id = connection?.getMediaEngineConnectionId?.(); return id == null ? null : this.statsStore?.getConnectionStats?.(id)?.stats; }
        catch { return null; }
    }

    controlRoute(connection) {
        try {
            const url = new URL(connection?._socket?.webSocket?.url);
            const route = this.sessionRoute;
            if (url.protocol === "ws:" && url.hostname === "127.0.0.1" && route &&
                Number(url.port) === route.port && url.pathname === `/${route.nonce}` && !route.stopped) return "VPN do Discord (ponte)";
            if (SessionClient.rtcHost(url.href)) return this.sessionRoute?"sem ponte; conferir política por processo":"direto";
        } catch {}
        return "não identificado";
    }

    transportSummary(stats) {
        const transport = stats?.transport;
        const output = [];
        for (const key of ["ping", "availableOutgoingBitrate", "inboundBitrateEstimate", "transportDelayMs", "transportPacketCount", "routingFailures", "decryptionFailures"]) {
            const value = transport?.[key];
            if (typeof value === "number" && Number.isFinite(value) && value >= 0)
                output.push(`${key}=${Math.round(value * 100) / 100}`);
        }
        return output.join(",") || "sem amostra";
    }

    voiceSummary() {
        try {
            const connection = this.rtcStore?.getRTCConnection?.();
            if (!connection) return "sem conexão de voz localizada";
            const ping = connection.getLastPing?.();
            const valid = typeof ping === "number" && Number.isFinite(ping) && ping >= 0;
            return `voz{estado=${this.safeState(connection.state)}; controle=${this.controlRoute(connection)}; pingRTC_ms=${valid ? Math.round(ping * 100) / 100 : "sem amostra"}; transporte[${this.transportSummary(this.connectionStats(connection))}]}`;
        } catch { return "sem amostra de voz"; }
    }

    mediaSummary() {
        const rows = [];
        for (const connection of this.streamConnections()) {
            let region = "desconhecida", stats, wants = "?";
            try { region = this.safeRegion(connection.getRegion?.() || connection.hostname); } catch {}
            try { const value = connection.hasActiveRemoteWants?.(); if (typeof value === "boolean") wants = value; } catch {}
            try {
                const id = connection.getMediaEngineConnectionId?.();
                if (id != null) stats = this.statsStore?.getConnectionStats?.(id)?.stats;
            } catch {}
            const inbound = stats?.rtp?.inbound;
            const inboundItems = inbound && typeof inbound === "object" ? Object.values(inbound).flatMap(value => Array.isArray(value) ? value : []) : null;
            rows.push(`${this.connectionRole(connection)}{estado=${this.safeState(connection.state)}; região=${region}; solicita vídeo=${wants}; ${this.nativeVideoSummary(connection)}; controle=${this.controlRoute(connection)}; transporte[${this.transportSummary(stats)}]; vídeo enviado[${this.videoCounters(stats?.rtp?.outbound)}]; vídeo recebido[${this.videoCounters(inboundItems)}]}`);
        }
        return rows.length ? rows.join(" | ") : "sem conexão RTC de stream localizada";
    }

    snapshot() {
        let variant = "?", originalVideo = "?", activeStream = "?";
        try {
            const userId = this.userStore?.getCurrentUser?.()?.id;
            const value = userId ? this.apexStore?.getServerAssignment?.("user", userId, GUARD) : undefined;
            variant = typeof value?.variantId === "number" ? String(value.variantId) : "sem atribuição";
        } catch {}
        try {
            const read = this.readConfig || this.guard?.getConfig?.bind(this.guard);
            const config = read?.({location: "CallShare diagnostic"}, {autoTrackExposure: false});
            if (typeof config?.videoEnabled === "boolean") originalVideo = String(config.videoEnabled);
        } catch {}
        try {
            const stream = this.streamStore?.getCurrentUserActiveStream?.();
            if (typeof this.streamStore?.getCurrentUserActiveStream === "function") activeStream = String(Boolean(stream));
        } catch {}
        const route=this.sessionRoute;
        const routing=route?.stopped&&!route.cleanupConfirmed?"restauração pendente":route?.lastStatus?.routesVerified&&!route.stopped?"VPN IPv4 verificada":route&&!route.stopped?"preparando":"conexão normal";
        return `etapa=${this.phase}; call=${Boolean(this.voiceChannelId())}; variante=${variant}; vídeo original=${originalVideo}; teste visual=${this.nativePatches.length > 0}; região solicitada=${this.region}; stream registrado=${activeStream}; rede=${routing}; modo=VPN temporária do Discord`;
    }

    record(event, detail = "") {
        if (!this.history) return;
        const row = `${new Date().toISOString()} | v${VERSION} | ${event}${detail ? " (" + detail + ")" : ""} | ${this.snapshot()}`.slice(0, 2400);
        this.history.push(row);
        this.history = this.history.slice(-160);
        try { BdApi.Data.save(NAME, "history", this.history); } catch {}
        if (event !== "amostra de mídia") {
            this.milestones.push(row);
            this.milestones = this.milestones.slice(-80);
            try { BdApi.Data.save(NAME, "milestones", this.milestones); } catch {}
        }
    }

    diagnostic() {
        this.captureRouteDiagnostics();
        return [
            `CallShare ${VERSION} — investigação do compartilhamento NATIVO`,
            this.snapshot(),
            `Experimento localizado: ${Boolean(this.guard)}`,
            `Consultas visuais alteradas: ${this.hits}`,
            `Preferência de região da call disponível: ${Boolean(this.regionStore)}`,
            `Preferência de região do stream disponível: ${Boolean(this.gatewayTarget)}`,
            `Eventos da sessão disponíveis: ${Boolean(this.dispatcher)}`,
            `Store RTC de stream disponível: ${Boolean(this.streamRtcStore)}`,
            `Store de contadores de mídia disponível: ${Boolean(this.statsStore)}`,
            `Conexões com observadores de handshake: ${Array.from(this.connectionHooks.values()).filter(undos => undos.length > 0).length}`,
            `Mídia atual: ${this.mediaSummary()}`,
            ...this.streamConnections().map(connection => `Negociação ${this.connectionRole(connection)}: ${this.negotiationSummary(connection)}`),
            `Voz atual: ${this.voiceSummary()}`,
            "Mapa estruturado de conexões, rotas e contadores (JSON; horários em milissegundos UTC):",
            JSON.stringify(this.structuredReport(),null,2),
            `Teste manual de camada local ativo: ${Boolean(this.videoTest)}`,
            `Rota de sessão: ${this.routeStatus || "desligada"}`,
            `Nova sessão confirmada na rota ativa: ${Boolean(this.routeSessionReady)}`,
            `WebSockets pela rota atual: ${this.routeEvidenceSummary(this.sessionRoute?.evidence ? {...this.sessionRoute.evidence(),sessionOpened:this.routeSessionReady} : null)}`,
            `RTC pela ponte VPN: ${this.sessionRoute?.stats?.rtc?.opened > 0 ? "ao menos uma conexão aberta; confira as conexões de voz e envio" : "nenhuma conexão RTC confirmada nesta rota"}`,
            this.sessionRoute ? `Controlador de rede: rota IPv4 verificada=${this.sessionRoute.lastStatus?.routesVerified===true}; restauração confirmada=${this.sessionRoute.cleanupConfirmed===true}` :
                "Controlador de rede: sem rota ativa; confira a restauração na última tentativa preservada.",
            `Última tentativa preservada: ${this.routeEvidenceSummary(this.lastRouteEvidence)}`,
            "Contadores de pacotes/bytes agregam camadas de vídeo; taxas de quadros usam o maior valor das camadas.",
            "Observadores de handshake cobrem callbacks vinculados após sua instalação; uma call já aberta pode ter cobertura parcial.",
            "Botões visíveis ou stream registrado não comprovam que a imagem chegou.",
            "Eventos do motor são observados após anexar os listeners; zero significa nenhum evento observado, e não ausência garantida de erro anterior. Primeiro quadro criptografado não comprova recebimento pelo espectador.",
            "Escopo: IPv4 do Discord por processo. No teste de voz direta, apenas o destino UDP da call atual recebe exceção anterior ao proxy. Restante do Discord segue no túnel; ainda não é somente transmissão. IPv6 do Discord é bloqueado. Conteúdos, credenciais e cabeçalhos não são coletados.",
            "", "Marcos preservados (UTC; amostras periódicas não apagam esta lista):", ...this.milestones,
            "", "Histórico recente (UTC):", ...this.history
        ].join("\n");
    }

    structuredReport() {
        const mode=this.sessionRoute?.stopped?(this.sessionRoute.cleanupConfirmed?'off':'restoring'):this.routeMode;
        let discord=null;try{const v=window.DiscordNative?.app?.getVersion?.();if(typeof v==='string'&&/^\d+(?:\.\d+){1,3}$/.test(v)&&v.length<40)discord=v;}catch{}
        return {version:VERSION,components:{discord,helperExpected:HELPER_VERSION,workerExpected:BACKEND_VERSION,routingSDK:'2.6.4 (pinned package)',driverPackage:'3.6.2.1 (pinned package)',openVPN:'2.7.8 (pinned binary)'},...this.routeDiagnostics.report(mode),currentRoute:this.sanitizeRouteEvidence(this.sessionRoute?.evidence?.()),
            lastRoute:this.lastRouteEvidence,lastEndedRoute:this.lastEndedRoute,providerMonitor:this.providerMonitor?.report(),voiceSummary:this.voiceSummary(),mediaSummary:this.mediaSummary(),automatic:this.autoPolicy?.report(),bootstrap:{...this.bootstrap?.report(),manualInThisCall:Boolean(this.manualDemandCall&&this.manualDemandCall===this.voiceChannelId())},strategy:this.routeStrategy,
            preparation:{insideCall:['voice-direct','standby'].includes(this.routeMode),gatewayReconnectRequested:this.routeMode==='full',voiceFilterVerified:this.sessionRoute?.lastStatus?.network?.voicePass?.verified===true,progress:this.routeProgress.map(row=>({...row}))}};
    }

    element(tag, text, className) {
        const el = document.createElement(tag);
        if (text) el.textContent = text;
        if (className) el.className = className;
        return el;
    }

    button(text, action, className) {
        const button = this.element("button", text, className);
        button.type = "button";
        button.addEventListener("click", () => {
            try { Promise.resolve(action()).catch(() => this.toast("Não foi possível concluir a ação.", "error")); }
            catch { this.toast("Não foi possível concluir a ação.", "error"); }
        });
        return button;
    }

    createToolbar() {
        document.getElementById(ROOT)?.remove();
        const bar = this.element("div");
        bar.id = ROOT;
        bar.setAttribute("role", "group");
        bar.setAttribute("aria-label", "CallShare — estado da conexão");
        this.routeShortcut=this.button('',()=>{
            if(this.routeShortcutAction==='panel'){
                this.panelTab='general';
                return this.showPanel();
            }
            return this.forceReconnect();
        },'cs-route-shortcut');this.routeShortcut.setAttribute('aria-live','polite');
        this.routeIndicator=this.element('span','','cs-indicator');this.routeIndicator.setAttribute('aria-hidden','true');
        const menu=this.button('CallShare',()=>document.getElementById(PANEL)?this.closePanel():this.showPanel(),'cs-menu');menu.setAttribute('aria-label','Abrir menu do CallShare');
        menu.setAttribute('aria-haspopup','dialog');menu.setAttribute('aria-controls',PANEL);menu.setAttribute('aria-expanded','false');this.menuButton=menu;
        bar.append(this.routeIndicator,this.routeShortcut,menu);
        this.toolbar=bar;
        document.body.append(bar);
        this.mountToolbar();
    }

    routeIsReady() {
        const route=this.sessionRoute;
        return Boolean(route&&!route.stopped&&!route.standby&&(this.voiceRouteReady||this.routeMode==='full'&&this.routeSessionReady)&&
            (route.lastVerifiedAt==null||Date.now()-route.lastVerifiedAt<=20000));
    }

    standbyIsReady() {const r=this.sessionRoute;return Boolean(r&&!r.stopped&&r.standby&&this.routeWarmReady&&r.lastStatus?.standbyVerified===true&&!r.lastStatus?.routingActive&&(r.lastVerifiedAt==null||Date.now()-r.lastVerifiedAt<=20000));}

    connectionView() {
        const auto=this.autoPolicy?.report()||{enabled:false,state:'off'},route=this.sessionRoute;
        if(this.routeDisableBusy||route?.stopped&&!route.cleanupConfirmed)return {title:'Voltando à conexão normal',description:'Aguarde a confirmação para preparar novamente.',tone:'working'};
        if(!route&&(auto.failure==='CS_PROVIDER_CA'||this.lastRouteFailure==='CS_PROVIDER_CA'))return {title:'Certificado da VPN indisponível',description:this.providerMonitor?.pending?'Consultando o certificado oficial do provedor. O Discord permanece na conexão normal.':this.providerMonitor?.result?.validated?'A última consulta encontrou um certificado válido. Clique em Reconectar para tentar preparar a conexão.':'O certificado não passou na validação. Use Validar certificado nas configurações avançadas. Depois de uma renovação válida, clique em Reconectar.',tone:'attention'};
        if(this.onDemandEnabled()){
            const state=this.bootstrap.state;
            if(state==='preparing')return {title:'Preparando o início da tela',description:'Ativando o encaminhamento pelo túnel em espera. Na primeira preparação, aguarde a VPN conectar.',tone:'working'};
            if(state==='media')return {title:'Aguardando a mídia começar',description:'O encaminhamento é temporário. Aguarda quadros e tráfego de vídeo antes de voltar à conexão normal; limite de 60 segundos.',tone:'working'};
            if(state==='restoring')return {title:'Voltando à espera',description:'Desligando o encaminhamento do Discord e mantendo o túnel conectado.',tone:'working'};
            if(state==='verifying')return {title:'Conexão normal · confirmando imagem',description:'O encaminhamento terminou. Verificando o avanço dos quadros; uma imagem estática pode não produzir novas amostras.',tone:'working',normal:true};
            if(state==='attention')return {title:'Confira a transmissão',description:(this.bootstrap.failure==='request-failed'?'O pedido de tela ao Discord falhou. ':'A imagem ainda não foi confirmada. ')+'Feche e abra novamente a tela para assistir. Para enviar sua tela, pare e inicie o compartilhamento pelos controles do Discord.',tone:'attention'};
            if(!route){
                if(auto.paused)return {title:'Conexão normal nesta call',description:'Sob demanda pausado. Preparar agora retoma nesta call.',tone:'normal'};
                if(!this.gatewayTarget)return {title:'Integração nativa indisponível',description:'Os gatilhos desta versão do Discord não foram identificados. Copie o relatório.',tone:'attention'};
                if(this.lastRouteFailure||['backoff','failed'].includes(auto.state))return {title:'A espera precisa de atenção',description:'Confira o auxiliar ou copie o relatório. Use Reconectar para tentar novamente.',tone:'attention'};
                return {title:'Preparando espera',description:'Ao entrar na call, o túnel será preparado em espera. Use os controles nativos para iniciar ou abrir uma tela.',tone:this.voiceChannelId()?'working':'normal',normal:!this.voiceChannelId()};
            }
        }
        if(this.standbyIsReady())return {title:'Túnel em espera',description:'VPN conectada; encaminhamento desligado. O Discord usa a conexão normal. Iniciar ou abrir uma tela ativa a rota temporariamente.',tone:'ready',normal:true};
        if(this.routeIsReady())return {title:'CallShare ativo',description:this.routeMode==='voice-direct'?'Voz na conexão normal. A rota permanece ativa para transmitir e assistir.':'Modo completo ativo: a voz também usa o túnel.',tone:'ready'};
        if(route&&!route.stopped)return {title:'Preparando sua conexão',description:'Aguarde a indicação de pronto antes de iniciar uma tela.',tone:'working'};
        if(auto.enabled&&auto.state==='failed')return {title:'A conexão precisa de atenção',description:'Confira o auxiliar ou copie o relatório. Use Reconectar para tentar novamente.',tone:'attention'};
        if(auto.enabled&&auto.state==='backoff')return {title:'Aguardando para reconectar',description:'O CallShare repetirá a tentativa com intervalo. Reconectar permite tentar agora.',tone:'attention'};
        if(auto.enabled&&auto.state==='paused')return {title:'Conexão normal nesta call',description:'Automático pausado até você retomar ou entrar em outra call.',tone:'normal'};
        if(auto.enabled&&auto.state==='waiting-media')return {title:'Aguardando a tela atual encerrar',description:'A preparação começa quando não houver transmissão aberta.',tone:'normal'};
        if(auto.enabled&&this.voiceChannelId())return {title:'Aguardando a voz estabilizar',description:'A conexão será preparada assim que o destino da voz estiver confirmado.',tone:'working'};
        return auto.enabled?{title:'Automático ativado',description:'Entre em uma call. O CallShare aguardará a voz e preparará a conexão.',tone:'normal'}:{title:'Conexão normal',description:this.voiceChannelId()?'Prepare a conexão para transmitir ou assistir.':'Entre em uma call para preparar a conexão.',tone:'normal'};
    }

    panelContext(view=this.connectionView()) {
        const call=this.voiceChannelId(),route=this.sessionRoute,active=this.routeIsReady(),standby=this.standbyIsReady();
        const state=this.bootstrap?.state,restoring=Boolean(this.routeDisableBusy||state==='restoring'||route?.stopped&&!route.cleanupConfirmed);
        let voice=null;try{voice=this.rtcStore?.getRTCConnection?.();}catch{}
        const saved=this.voicePreservation,proof=route?.lastStatus?.network?.voicePass;
        const observed=saved&&this.routeDiagnostics?.connections.find(row=>row.id===saved.id&&row.active);
        const sameVoice=saved?.channel===call&&observed?.state==='RTC_CONNECTED'&&observed?.media?.ip===saved?.voice?.ip&&observed?.media?.port===saved?.voice?.port;
        const voiceConnected=voice?.state==='RTC_CONNECTED';
        const voiceDirect=voiceConnected&&Boolean(!route&&!restoring||standby||active&&this.routeMode==='voice-direct'&&sameVoice&&proof?.verified&&proof.requested?.ip===saved.voice.ip&&proof.requested?.port===saved.voice.port);
        const streams=this.streamConnections(),connected=streams.filter(row=>row.state==='RTC_CONNECTED');
        return {call,hasRoute:Boolean(route),automatic:this.autoPolicy?.enabled,paused:Boolean(call&&this.autoPolicy?.pausedCall===call),active,standby,restoring,
            preparing:Boolean(route&&!active&&!standby&&!route.stopped),verifying:state==='verifying',mediaStarting:['preparing','media'].includes(state),mediaAttention:state==='attention',
            tone:view.tone,technicalTitle:view.title,technicalDescription:view.description,voiceConnected,voiceDirect,fullRouting:active&&this.routeMode==='full',hasStreams:streams.length>0,
            sending:connected.some(row=>row.isOwner===true),receiving:connected.some(row=>row.isOwner===false)};
    }

    icon(kind) {
        const paths={screen:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
            check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',warning:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4m0 4h.01"/>',
            spinner:'<path d="M21 12a9 9 0 1 1-9-9"/>',pause:'<path d="M9 5v14M15 5v14"/>',arrow:'<path d="m9 5 7 7-7 7"/>',minus:'<path d="M5 12h14"/>'};
        const node=this.element('span',null,'cs-icon'+(kind==='spinner'?' cs-spinner':''));node.setAttribute('aria-hidden','true');
        node.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+(paths[kind]||paths.screen)+'</svg>';
        return node;
    }

    updateToolbar() {
        this.mountToolbar();
        const view=this.connectionView(),call=this.voiceChannelId(),auto=this.autoPolicy;
        const presentation=panelPresentation(this.panelContext(view));
        if(this.routeIndicator){
            this.routeIndicator.title='CallShare: '+presentation.title;
            if(this.routeIndicator.getAttribute('data-tone')!==presentation.tone){
                this.routeIndicator.setAttribute('data-tone',presentation.tone);this.routeIndicator.replaceChildren();
                if(['ready','attention'].includes(presentation.tone))this.routeIndicator.append(this.icon(presentation.tone==='ready'?'check':'warning'));
            }
        }
        const setText=(element,value)=>{if(element&&element.textContent!==value)element.textContent=value;};
        const shortcut=presentation.shortcut;
        this.routeShortcutAction=presentation.shortcutAction;
        setText(this.routeShortcut,shortcut);
        if(this.routeShortcut){this.routeShortcut.disabled=!call||presentation.tone==='ready'||presentation.tone==='working';this.routeShortcut.title=presentation.description;this.routeShortcut.setAttribute('aria-label',presentation.shortcutAction==='panel'?'Abrir orientações sobre a transmissão':shortcut==='Reconectar'?'Reconectar CallShare':presentation.title);}
        if(!this.panelCard)return;
        this.renderMaintenance();
        const detailed=view.tone==='working'&&!view.normal&&(this.sessionRoute||this.routeDisableBusy)&&this.routeProgress.length?this.routeProgress.at(-1).label:view.description;
        const provider=this.sessionRoute?.lastStatus?.provider,providerName=provider?.selected?providerLabel(provider.selected):null;
        const panelDescription=this.devMode?detailed:view.tone==='working'&&!view.normal&&this.routeProgress.length&&this.sessionRoute?this.routeProgress.at(-1).label:presentation.description;
        setText(this.panelTitle,this.devMode?view.title:presentation.title);setText(this.panelDescription,providerName?`${providerName} · ${panelDescription}`:panelDescription);this.panelCard?.setAttribute('data-tone',this.devMode?view.tone:presentation.tone);
        if(this.panelStateIcon&&this.panelStateIcon.getAttribute('data-icon')!==presentation.icon){this.panelStateIcon.setAttribute('data-icon',presentation.icon);this.panelStateIcon.replaceChildren(this.icon(presentation.icon));}
        for(const key of ['voice','tunnel','sharing']){
            const row=this.panelRows?.[key],tone=presentation[key+'Tone'];if(!row)continue;setText(row.value,presentation[key]);
            if(row.box.getAttribute('data-tone')!==tone){row.box.setAttribute('data-tone',tone);row.marker.replaceChildren(this.icon(tone==='ready'?'check':tone==='attention'?'warning':tone==='working'?'spinner':'minus'));row.marker.hidden=tone==='normal';}
        }
        setText(this.panelProviderSummary,providerName?providerName+' · '+(this.routeStrategy==='on-demand'?'sob demanda':'modo contínuo'):'Preferência: Riseup · alternativa: CoopVPN');
        this.renderPanelProgress(view);
        if(this.panelProviderInfo){
            const info=this.providerMonitor?.result,names={ready:'válido',expiring:'perto do vencimento',expired:'vencido','not-yet-valid':'ainda sem validade','fingerprint-mismatch':'divergente do anunciado',invalid:'inválido',unavailable:'consulta indisponível'};
            setText(this.panelProviderInfo,this.providerMonitor?.pending?'Consultando certificado oficial…':info?`Riseup: certificado ${names[info.status]||'não confirmado'}. ${info.expiresAt?'Validade até '+new Date(info.expiresAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})+' (São Paulo). ':''}Última consulta: ${new Date(info.checkedAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}. Validação manual; não altera sua conexão.`:'Use Validar certificado para conferir a validade na fonte oficial, sem mudar a conexão atual. Não há consultas automáticas.');
        }
        if(this.panelProviderSession){
            const duration=n=>Math.floor((n||0)/60000)+' min';
            setText(this.panelProviderSession,providerName?`Provedor: ${providerName}. Sessão: ${duration(provider.sessionAgeMs)}; em espera: ${duration(provider.standbyMs)}; encaminhando: ${duration(provider.activeMs)}. Limite de duração: não publicado. A preferência Riseup será reavaliada no próximo preparo.`:'Preferência: Riseup; alternativa automática: CoopVPN. A troca só ocorre no preparo de um novo túnel.');
        }
        const actions=panelActions({call,hasRoute:Boolean(this.sessionRoute),restoring:this.routeDisableBusy||this.routeSwitchBusy,
            verifying:this.bootstrap.state==='verifying',preparing:Boolean(this.sessionRoute&&!this.routeIsReady()&&!this.standbyIsReady()),
            active:this.routeIsReady(),standby:this.standbyIsReady(),onDemand:this.routeStrategy==='on-demand',paused:this.autoPolicy?.pausedCall===call,failure:this.lastRouteFailure||auto?.failure});
        this.panelAction=actions.action;
        setText(this.panelConnect,actions.primary);if(this.panelConnect)this.panelConnect.disabled=actions.disabled;
        setText(this.panelRestore,actions.secondary);if(this.panelRestore)this.panelRestore.disabled=actions.secondaryDisabled;
        if(this.panelRestore)this.panelRestore.hidden=!this.devMode&&actions.secondaryDisabled;
        if(this.panelInstall){
            this.panelInstall.hidden=false;
            this.panelInstall.disabled=!this.canInstallNativeHelper();
            this.panelInstall.title=this.canInstallNativeHelper()?'Abre o instalador do serviço incluído em CallShare-runtime.':'Pause o CallShare e aguarde o túnel encerrar antes de instalar ou reparar o auxiliar.';
        }
        const layoutKey=JSON.stringify([view.title,detailed,presentation.title,presentation.voice,presentation.tunnel,presentation.sharing,actions.primary,this.routeProgress.length]);
        if(this.panelLayoutKey!==layoutKey){this.panelLayoutKey=layoutKey;this.positionPanel();}
    }

    mountToolbar() {
        if(!this.toolbar||!this.running)return;
        let host=null;
        for(const button of document.querySelectorAll('button[aria-label]')) {
            const label=button.getAttribute('aria-label');
            if(!['User Settings','Configurações de usuário','Configurações do usuário'].includes(label))continue;
            host=button.closest('[class*="panels_"]');if(host)break;
        }
        const parent=host||document.body;
        if(this.toolbar.parentElement!==parent)parent.append(this.toolbar);
        this.toolbar.setAttribute('data-mounted',String(Boolean(host)));
    }

    observeToolbarMount() {
        if(typeof MutationObserver!=='function')return;
        const observer=new MutationObserver(records=>{
            if(this.mountTimer||!this.running||!records.some(r=>r.type==='childList'))return;
            this.mountTimer=setTimeout(()=>{this.mountTimer=null;this.updateToolbar();},200);
        });
        observer.observe(document.body,{childList:true,subtree:true});this.cleanups.push(()=>observer.disconnect());
    }

    popupHost() {
        const themed=this.toolbar?.parentElement?.closest?.('.theme-dark,.theme-light,.theme-darker,.theme-midnight,[data-theme]');
        return themed&&themed!==document.documentElement?themed:document.getElementById('app-mount')||document.body;
    }

    renderPanelProgress(view) {
        if(!this.panelProgress)return;
        const rows=this.routeProgress.slice(-4),visible=view.tone==='working'&&rows.length>0&&Boolean(this.sessionRoute||this.routeDisableBusy);
        this.panelProgress.hidden=!visible;
        const key=JSON.stringify([visible,rows]);if(this.panelProgressKey===key)return;this.panelProgressKey=key;
        this.panelProgress.replaceChildren();
        if(!visible)return;
        for(const [index,row] of rows.entries()){
            const item=this.element('li'),seconds=Math.floor(row.elapsedMs/1000),stamp=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
            item.append(this.element('span',stamp,'cs-progress-time'),this.element('span',row.label));
            if(index===rows.length-1)item.setAttribute('aria-current','step');
            this.panelProgress.append(item);
        }
    }

    closePanel({restoreFocus=true}={}) {
        this.panelCleanup?.();this.panelCleanup=null;
        document.getElementById(PANEL)?.remove();this.menuButton?.setAttribute('aria-expanded','false');
        this.setupNotice=this.setupText=this.setupAction=this.releaseNotice=this.releaseText=this.updateButton=this.feedStatus=null;
        for(const key of ['panelTitle','panelDescription','panelCard','panelProgress','panelProviderInfo','panelProviderSession','panelProviderSummary','panelConnect','panelRestore','panelInstall','panelStateIcon','panelRows','panelTabs','panelPages','panelAdvanced','panelDevButton','panelAutomatic','panelContinuous'])this[key]=null;
        if(restoreFocus)(this.panelInvoker?.isConnected===false?this.menuButton:this.panelInvoker||this.menuButton)?.focus?.();this.panelInvoker=null;
    }

    positionPanel() {
        const panel=document.getElementById(PANEL),anchor=this.menuButton?.getBoundingClientRect?.();
        if(!panel?.style||!anchor||!panel.getBoundingClientRect)return;
        const width=window.innerWidth||800,height=window.innerHeight||600,margin=8;
        panel.style.width=Math.max(0,Math.min(this.devMode?440:400,width-margin*2))+'px';panel.style.maxHeight=Math.max(0,height-margin*2)+'px';
        const rect=panel.getBoundingClientRect(),above=anchor.top-rect.height-margin,below=anchor.bottom+margin;
        panel.style.left=Math.max(margin,Math.min(width-rect.width-margin,anchor.right-rect.width))+'px';
        panel.style.top=Math.max(margin,Math.min(height-rect.height-margin,above>=margin?above:below))+'px';panel.style.bottom='auto';
    }

    async runPanelAction() {
        if(this.panelAction==='pause')return this.disableSessionRoute();
        if(this.panelAction==='standby'){this.bootstrap.cancel();return this.suspendSessionRoute();}
        if(this.panelAction==='connect')return this.forceReconnect();
    }

    shortDiagnostic() {
        const p=routeProvider(this.sessionRoute?.lastStatus?.provider),started=this.routeDiagnostics.started;
        const failure=this.lastRouteFailure||this.autoPolicy?.failure;
        return JSON.stringify({version:VERSION,run:'cs-'+Number(started||0).toString(36),at:new Date().toISOString(),windowMs:Math.max(0,Date.now()-(started||Date.now())),
            state:this.connectionView().title,provider:p?.selected||null,lastFailure:/^CS_[A-Z_]{1,50}$/.test(failure||'')?failure:null,
            attempts:p?.attempts||[],sessionAgeMs:p?.sessionAgeMs??null,activeMs:p?.activeMs??null,standbyMs:p?.standbyMs??null,
            dropped:{...this.routeDiagnostics.dropped}},null,2);
    }

    appendPanelOverview(panel,{compact=false}={}) {
        const card=this.element('div',null,'cs-status');
        this.panelTitle=this.element('h3');this.panelDescription=this.element('p');this.panelCard=card;
        const body=this.element('div',null,'cs-status-body');body.append(this.panelTitle,this.panelDescription);
        if(compact){this.panelStateIcon=this.element('span',null,'cs-status-icon');card.append(this.panelStateIcon);}
        card.append(body);panel.append(card);
        if(compact){
            const summary=this.element('dl',null,'cs-summary');summary.setAttribute('aria-label','Resumo da conexão');this.panelRows={};
            for(const [key,label] of [['voice','Conexão de voz'],['tunnel','Túnel VPN'],['sharing','Tela no Discord']]){
                const row=this.element('div',null,'cs-summary-row'),box=this.element('dd'),marker=this.element('span'),value=this.element('span',null,'cs-row-value');
                marker.setAttribute('aria-hidden','true');box.append(marker,value);row.append(this.element('dt',label),box);summary.append(row);this.panelRows[key]={box,marker,value};
            }panel.append(summary);
        }
        this.panelProgress=this.element('ol',null,'cs-progress');this.panelProgress.setAttribute('aria-label','Últimas etapas da preparação');this.panelProgressKey=null;
        if(!compact)body.append(this.panelProgress);
        const actions=this.element('div',null,'cs-actions'+(compact?' cs-main-actions':''));
        this.panelConnect=this.button('Preparar agora',()=>this.runPanelAction(),'cs-primary');
        this.panelRestore=this.button('Voltar à conexão normal',()=>this.disableSessionRoute(),compact?'cs-secondary-action':undefined);
        actions.append(this.panelConnect,this.panelRestore);panel.append(actions);
    }

    appendAutomaticControl(panel,{compact=false}={}) {
        const autoLabel=this.element('label'),auto=this.element('input');auto.type='checkbox';auto.checked=this.autoPolicy.enabled;
        this.panelAutomatic=auto;if(compact)autoLabel.className='cs-automatic';
        auto.setAttribute('aria-label','Preparar o CallShare ao entrar na call');
        auto.addEventListener('change',()=>{this.setAutomatic(auto.checked);this.showPanel();this.panelAutomatic?.focus?.();});
        autoLabel.append(auto,this.element('span',this.routeStrategy==='on-demand'?'Preparar ao entrar na call':'Preparar automaticamente'));
        panel.append(autoLabel);
        if(!compact)panel.append(this.element('p',this.routeStrategy==='on-demand'?(this.autoPolicy.enabled?'Prepara a VPN em espera ao entrar na call.':'Use Preparar agora para deixar a VPN em espera nesta call.')+' O Discord fica na conexão normal. Iniciar ou abrir uma tela ativa a rota por alguns segundos; depois ela volta à espera. A voz permanece direta.':'Espera a voz conectar e mantém a rota na call, verificando e recuperando a conexão. A tela e o áudio continuam nos controles nativos do Discord.','cs-muted'));
    }

    appendReportCopies(panel) {
        const copies=this.element('div',null,'cs-actions');copies.append(this.button('Copiar resumo',()=>this.copy(this.shortDiagnostic())),this.button('Copiar relatório completo',()=>this.copy(this.diagnostic())));panel.append(copies);
    }

    appendAdvancedOptions(advanced,{compact=false}={}) {
        if(compact)advanced.append(this.element('h3','Conexão','cs-section-title'));
        this.panelProviderSession=this.element('p',null,'cs-muted');advanced.append(this.panelProviderSession);
        this.panelProviderInfo=this.element('p',null,'cs-muted');advanced.append(this.panelProviderInfo,this.button('Validar certificado',()=>this.validateProviderCertificate()));
        if(compact)advanced.append(this.element('h3','Compatibilidade','cs-section-title'));
        const strategyLabel=this.element('label'),continuous=this.element('input');continuous.type='checkbox';continuous.checked=this.routeStrategy==='continuous';
        this.panelContinuous=continuous;
        continuous.addEventListener('change',()=>{this.setRouteStrategy(continuous.checked?'continuous':'on-demand').then(()=>{if(this.running){this.showPanel();this.panelContinuous?.focus?.();}});});
        strategyLabel.append(continuous,this.element('span','Manter túnel na call · modo contínuo anterior'));advanced.append(strategyLabel);
        if(compact)advanced.append(this.element('h3','Instalação e manutenção','cs-section-title'));
        this.panelInstall=this.button('Instalar/atualizar auxiliar',()=>this.installNativeHelper());
        const setup=this.element('div',null,'cs-actions');setup.append(this.panelInstall,this.button('Preparação completa · alternativa',()=>this.enableSessionRoute()));advanced.append(setup);
        this.appendUpdateSettings(advanced);
        advanced.append(this.element('p','Use esse botão para instalar ou reparar o serviço do Windows. Quando houver uma nova versão do pacote, saia da call e clique em Atualizar no aviso do CallShare.','cs-muted'));
        const explanations=compact?this.element('details'):advanced;if(compact)explanations.append(this.element('summary','Como a conexão funciona'));
        const routeText=this.element('p','Detalhe da conexão: '+this.routeStatus);routeText.id='callshare-route-state';explanations.append(routeText);
        explanations.append(this.element('p','Durante a preparação, a voz atual fica direta e o restante do Discord usa o túnel; ainda não é um filtro exclusivo de vídeo. No modo sob demanda, o encaminhamento é desligado após o início da mídia ou após 60 segundos sem confirmação. A VPN permanece conectada em espera, sem encaminhar o Discord. Sair da call encerra a VPN. Outros aplicativos mantêm a conexão normal. O IPv6 do Discord fica bloqueado somente enquanto o encaminhamento IPv4 está ativo.'));
        explanations.append(this.element('p','Voltar à espera desliga apenas o encaminhamento. Pausar nesta call encerra o túnel e suspende novas preparações nesta call; Retomar prepara novamente. Na transmissão enviada, os contadores locais não comprovam que um espectador recebeu a imagem.'));
        const label=this.element('label'),toggle=this.element('input');toggle.type='checkbox';toggle.checked=this.nativeEnabled;
        toggle.addEventListener('change',()=>{this.nativeEnabled=toggle.checked;BdApi.Data.save(NAME,'nativeEnabled',this.nativeEnabled);if(this.nativeEnabled)this.applyNativePatch();else this.removeNativePatch();this.record('controles nativos '+(this.nativeEnabled?'visíveis':'restaurados'));});
        label.append(toggle,this.element('span','Manter controles nativos visíveis'));advanced.append(label);
        explanations.append(this.element('p','OpenVPN com Riseup e CoopVPN, sem conta ou configuração manual. A instalação do serviço protegido pede autorização do Windows; atualizações somente do plugin e helper não exigem reinstalar esse serviço. O driver Windows Packet Filter tem licença separada para uso pessoal. Licenças no pacote.'));
        if(compact){advanced.append(explanations,this.element('h3','Diagnóstico','cs-section-title'));if(this.panelProgress)advanced.append(this.panelProgress);this.appendReportCopies(advanced);}
        const reportDetails=this.element('details'),report=this.element('pre');reportDetails.append(this.element('summary','Ver relatório técnico'),report);
        reportDetails.addEventListener('toggle',()=>{if(reportDetails.open&&!report.textContent)report.textContent=this.diagnostic();});
        const reportActions=this.element('div',null,'cs-actions');reportActions.append(this.button('Atualizar relatório',()=>{report.textContent=this.diagnostic();}),this.button('Copiar mapa de rede (JSON)',()=>{this.captureRouteDiagnostics();return this.copy(JSON.stringify(this.structuredReport(),null,2));}),this.button('Limpar histórico local',()=>{this.clearHistory();report.textContent=this.diagnostic();}));reportDetails.append(reportActions);advanced.append(reportDetails);
    }

    selectPanelTab(tab,{focus=false}={}) {
        if(!this.panelTabs||!this.panelPages)return;
        const previous=this.panelTab;
        this.panelTab=tab==='advanced'?'advanced':'general';
        for(const key of ['general','advanced']){
            const selected=key===this.panelTab;this.panelTabs[key].setAttribute('aria-selected',String(selected));this.panelTabs[key].tabIndex=selected?0:-1;this.panelPages[key].hidden=!selected;
        }
        const panel=document.getElementById(PANEL);if(panel&&previous!==this.panelTab)panel.scrollTop=0;
        if(focus)this.panelTabs[this.panelTab].focus?.();this.positionPanel();
    }

    showPanel() {
        if(!this.running)return this.toast('Ative o CallShare na lista de plugins para abrir o menu.');
        const invoker=document.getElementById(PANEL)?this.panelInvoker||this.menuButton:document.activeElement&&document.activeElement!==document.body?document.activeElement:this.menuButton;this.closePanel({restoreFocus:false});this.panelInvoker=invoker;
        const panel=this.element('section');panel.id=PANEL;panel.setAttribute('aria-label',this.devMode?'CallShare — modo dev':'CallShare — conexão');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');panel.setAttribute('data-mode',this.devMode?'dev':'simple');panel.tabIndex=-1;
        const header=this.element('div',null,'cs-header'),heading=this.element('div',null,'cs-heading'),logo=this.icon('screen');logo.className+=' cs-logo';
        heading.append(logo,this.element('h2','CallShare'),this.element('span','v'+VERSION,'cs-version'));
        const close=this.button('Fechar',()=>this.closePanel(),'cs-close');
        header.append(heading,close);panel.append(header);
        this.setupNotice=this.element('div',null,'cs-notice');
        this.setupText=this.element('p');
        this.setupAction=this.button('Instalar auxiliar',()=>this.installNativeHelper());
        this.setupNotice.append(this.setupText,this.setupAction);
        this.releaseNotice=this.element('div',null,'cs-notice');
        this.releaseNotice.setAttribute('role','status');
        this.releaseText=this.element('p');this.updateButton=this.button('Atualizar',()=>this.installPackageUpdate());
        this.releaseNotice.append(this.releaseText,this.updateButton);
        panel.append(this.setupNotice,this.releaseNotice);
        if(this.devMode){
            this.appendPanelOverview(panel);this.appendAutomaticControl(panel);this.appendReportCopies(panel);
            const advanced=this.element('details');advanced.append(this.element('summary','Configurações avançadas e diagnóstico'));this.panelAdvanced=advanced;this.appendAdvancedOptions(advanced);panel.append(advanced);
        }else{
            const tabs=this.element('div',null,'cs-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Seções do CallShare');this.panelTabs={};this.panelPages={};
            for(const [key,label] of [['general','Geral'],['advanced','Avançado']]){
                const button=this.button(label,()=>this.selectPanelTab(key,{focus:true}));button.id='callshare-tab-'+key;button.setAttribute('role','tab');button.setAttribute('aria-controls','callshare-page-'+key);
                button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();this.selectPanelTab(event.key==='Home'?'general':event.key==='End'?'advanced':key==='general'?'advanced':'general',{focus:true});});
                const page=this.element('div',null,key==='advanced'?'cs-advanced-options':null);page.id='callshare-page-'+key;page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby',button.id);page.tabIndex=0;
                this.panelTabs[key]=button;this.panelPages[key]=page;tabs.append(button);
            }
            panel.append(tabs,this.panelPages.general,this.panelPages.advanced);
            this.appendPanelOverview(this.panelPages.general,{compact:true});this.appendAutomaticControl(this.panelPages.general,{compact:true});
            this.appendAdvancedOptions(this.panelPages.advanced,{compact:true});this.selectPanelTab(this.panelTab);
        }
        const footer=this.element('div',null,'cs-mode-footer');this.panelDevButton=this.button(this.devMode?'Voltar ao modo simples':'Modo dev',()=>{
            this.devMode=!this.devMode;BdApi.Data.save(NAME,'devMode',this.devMode);this.panelTab='general';this.showPanel();this.panelDevButton?.focus?.();
        });this.panelDevButton.setAttribute('aria-pressed',String(this.devMode));this.panelDevButton.title='Alterna apenas a apresentação; mantém os mesmos diagnósticos e funcionamento.';
        if(this.devMode)footer.append(this.element('span','Leitura técnica completa'));
        footer.append(this.panelDevButton);panel.append(footer);
        this.popupHost().append(panel);this.menuButton?.setAttribute('aria-expanded','true');
        const keydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.closePanel();}};
        const reposition=()=>this.positionPanel();document.addEventListener?.('keydown',keydown,true);window.addEventListener?.('resize',reposition);window.addEventListener?.('scroll',reposition,true);
        panel.addEventListener('toggle',reposition,true);this.panelCleanup=()=>{document.removeEventListener?.('keydown',keydown,true);window.removeEventListener?.('resize',reposition);window.removeEventListener?.('scroll',reposition,true);};
        this.updateToolbar();this.positionPanel();close.focus?.();
    }

    openNative() {
        if (!this.voiceChannelId()) return this.toast("Entre em uma call primeiro.", "warning");
        const labels = new Set(["share your screen", "share screen", "screen share", "compartilhar sua tela", "compartilhar a tela", "compartilhar tela", "compartilhe sua tela", "compartilhar ecrã"]);
        const candidates = [...document.querySelectorAll("button,[role=button]")].filter(el => {
            if (el.closest(`#${ROOT},#${PANEL}`) || el.disabled || el.getAttribute("aria-disabled") === "true" || !el.getClientRects().length) return false;
            return [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent].some(value => value && labels.has(value.trim().toLocaleLowerCase()));
        });
        if (candidates.length !== 1) {
            this.showPanel();
            return this.toast("O botão nativo ainda não foi identificado. Confira a opção de exibir controles e os botões da call.", "warning");
        }
        this.record("abrir seletor nativo");
        document.getElementById(PANEL)?.remove();
        candidates[0].click();
    }

    async copy(text) {
        let clipboard;
        try { clipboard = require("electron").clipboard; } catch {}
        if (clipboard?.writeText) clipboard.writeText(text); else await navigator.clipboard.writeText(text);
        this.toast("Relatório copiado.");
    }

    toast(text, type = "info") { BdApi.UI.showToast(text, {type}); }

    recordNegotiation() {
        for (const connection of this.streamConnections()) this.record("negociação nativa", `tipo=${this.connectionRole(connection)}; ${this.negotiationSummary(connection)}`);
    }

    clearHistory() {
        if(this.bootstrap)this.bootstrap.history=[];
        this.routeDiagnostics.clearRecords();
        this.syncConnectionHooks();
        this.history = []; this.milestones = [];
        this.record("histórico reiniciado");
    }

    updateRouteStatus(value) {
        this.routeStatus = value;
        const label=typeof value==='string'?value.replace(/[\r\n\t]/g,' ').slice(0,300):'';
        if(label&&this.routeProgress.at(-1)?.label!==label){
            if(this.progressStartedAt==null)this.progressStartedAt=Date.now();
            this.routeProgress.push({elapsedMs:Math.max(0,Date.now()-this.progressStartedAt),label});
            if(this.routeProgress.length>8)this.routeProgress.shift();
        }
        const text = document.getElementById("callshare-route-state");
        if (text) text.textContent = "Rota de sessão: " + value;
        this.updateToolbar();
    }

    sanitizeEndedRoute(value) {
        if(!value||!Number.isSafeInteger(value.at)||value.at<0)return null;
        const failure=SessionClient.terminalCode(value.failure);if(!failure)return null;
        return {at:value.at,failure,evidence:this.sanitizeRouteEvidence(value.evidence)};
    }

    sanitizeRouteEvidence(value) {
        if (!value || !["rtc", "gateway"].includes(value.scope)) return null;
        const out = {scope:value.scope,sessionOpened:value.sessionOpened === true,provider:routeProvider(value.provider),terminalFailure:SessionClient.terminalCode(value.terminalFailure),routerLifecycle:routeRouterLifecycle(value.routerLifecycle),routingActive:value.routingActive===true,standbyVerified:value.standbyVerified===true};
        out.network=routeNativeSnapshot(value.network);out.networkBefore=routeNativeSnapshot(value.networkBefore);out.networkAfter=routeNativeSnapshot(value.networkAfter);
        out.environment=routeEnvironment(value.environment);
        out.health=routeHealth(value.health);out.lastVerifiedAt=Number.isSafeInteger(value.lastVerifiedAt)&&value.lastVerifiedAt>=0?value.lastVerifiedAt:null;
        out.voiceFilter=routeVoiceProof(value.voiceFilter);
        out.backend=['leap-openvpn-process','riseup-openvpn'].includes(value.backend)?value.backend:'legacy-tor';
        out.country=/^[A-Z]{2}$/.test(value.country||'')?value.country:null;
        out.isolationVerified=out.backend==='leap-openvpn-process'&&value.isolationVerified===true;out.normalRoutePreserved=value.normalRoutePreserved===true;
        out.isolationError=Number.isInteger(value.isolationError)&&value.isolationError>=0&&value.isolationError<=4294967295?value.isolationError:null;
        out.isolationStage=['engine-open','sublayer-add','app-id','interface-luid','filter-add','ready'].includes(value.isolationStage)?value.isolationStage:null;
        out.addressState=['not-checked','missing','preferred','tentative','duplicate','deprecated','invalid'].includes(value.addressState)?value.addressState:null;
        out.proxyDiagnostic=null;
        if(value.proxyDiagnostic&&typeof value.proxyDiagnostic==='object'&&!Array.isArray(value.proxyDiagnostic)){
            const diagnostic=value.proxyDiagnostic;out.proxyDiagnostic={stage:['ready','create','bind','interface','resolve','connect','connected'].includes(diagnostic.stage)?diagnostic.stage:null,
                category:['dns','refused','denied','network-unreachable','host-unreachable','timeout','local-address','internal'].includes(diagnostic.category)?diagnostic.category:null,
                nativeCode:Number.isInteger(diagnostic.nativeCode)&&diagnostic.nativeCode>=0&&diagnostic.nativeCode<=65535?diagnostic.nativeCode:null,
                attempts:Number.isInteger(diagnostic.attempts)&&diagnostic.attempts>=0&&diagnostic.attempts<=3?diagnostic.attempts:0,
                addresses:Number.isInteger(diagnostic.addresses)&&diagnostic.addresses>=0&&diagnostic.addresses<=3?diagnostic.addresses:0,
                socksReply:Number.isInteger(diagnostic.socksReply)&&diagnostic.socksReply>=0&&diagnostic.socksReply<=8?diagnostic.socksReply:null};
        }
        out.routeProof=null;
        if(value.routeProof&&typeof value.routeProof==='object'&&!Array.isArray(value.routeProof)){
            const proof=value.routeProof;out.routeProof={inspected:proof.inspected===true,tunnelPresent:proof.tunnelPresent===true,normalPreserved:proof.normalPreserved===true,
                reason:['verified','tunnel-default-missing','tunnel-metric-too-low','normal-default-changed','normal-prefix-conflict','read-failed'].includes(proof.reason)?proof.reason:null,
                ownRoutes:Number.isInteger(proof.ownRoutes)&&proof.ownRoutes>=0&&proof.ownRoutes<=65535?proof.ownRoutes:0,
                ignoredControlRoutes:Number.isInteger(proof.ignoredControlRoutes)&&proof.ignoredControlRoutes>=0&&proof.ignoredControlRoutes<=65535?proof.ignoredControlRoutes:0,
                tunnelMetric:Number.isInteger(proof.tunnelMetric)&&proof.tunnelMetric>=0&&proof.tunnelMetric<=4294967295?proof.tunnelMetric:null};
        }
        out.serviceStage=['starting','listening','responded','stopped','start-failed','pipe-failed','request-failed'].includes(value.serviceStage)?value.serviceStage:null;
        out.serviceFailure=['CS_SERVICE_BUSY','CS_SERVICE_AUTH','CS_SERVICE_INPUT','CS_SERVICE_LAUNCH','CS_SERVICE_START','CS_SERVICE_PIPE'].includes(value.serviceFailure)?value.serviceFailure:null;
        out.serviceNativeCode=Number.isInteger(value.serviceNativeCode)&&value.serviceNativeCode>=0&&value.serviceNativeCode<=4294967295?value.serviceNativeCode:null;
        out.processRuleCount=Number.isInteger(value.processRuleCount)&&value.processRuleCount>=0&&value.processRuleCount<=4?value.processRuleCount:0;
        for(const field of ['tcpRelays','udpRelays'])out[field]=Number.isSafeInteger(value[field])&&value[field]>=0?value[field]:0;
        out.probe={stage:['not-started','local-proxy','target','tls','http','passed'].includes(value.probe?.stage)?value.probe.stage:null};
        out.probe.code=['CS_PROBE_CONNECT','CS_PROBE_TIMEOUT','CS_PROBE_DNS','CS_PROBE_REFUSED','CS_PROXY_BIND','CS_PROXY_SOCKET','CS_PROXY_DENIED','CS_PROXY_INTERFACE','CS_PROXY_LOCAL_ADDRESS','CS_PROBE_NETWORK_UNREACHABLE','CS_PROBE_HOST_UNREACHABLE','CS_VPN_ADDRESS_NOT_READY','CS_PROBE_TARGET','CS_PROBE_TLS','CS_PROBE_HTTP','CS_PROXY_TARGET','CS_PROXY_NOT_READY','CS_PROXY_PROTOCOL','CS_PROXY_AUTH'].includes(value.probe?.code)?value.probe.code:null;
        out.probe.httpStatus=Number.isInteger(value.probe?.httpStatus)&&value.probe.httpStatus>=100&&value.probe.httpStatus<=599?value.probe.httpStatus:null;
        out.routesVerified=value.routesVerified===true;out.cleanupConfirmed=value.cleanupConfirmed===true;
        out.workerStage=['idle','extracting','driver','adapter','isolating','address','connecting','connected','stopping','stopped','failed','cleanup-failed'].includes(value.workerStage)?value.workerStage:null;
        const reasons=['options','certificate','authentication','identity','adapter-missing','adapter-open','adapter-index','driver-io','exit-event','handshake','network-config'];
        const markers=[...reasons,'driver-missing','driver-version','certificate-verified','peer-authenticated','configuration-received','initialized','fatal-exit','adapter-ready'];
        out.nativeExitCode=Number.isInteger(value.nativeExitCode)&&value.nativeExitCode>=-2147483648&&value.nativeExitCode<=2147483647?value.nativeExitCode:null;
        out.nativeReason=reasons.includes(value.nativeReason)?value.nativeReason:null;
        out.nativeMarkers=Array.isArray(value.nativeMarkers)?[...new Set(value.nativeMarkers.filter(v=>markers.includes(v)))].slice(0,20):[];
        for (const key of ["rtcPorts", "unroutedRtcPorts"]) out[key] = Array.isArray(value[key]) ?
            [...new Set(value[key].filter(n => Number.isInteger(n) && n >= 1 && n <= 65535))].slice(0, 8) : [];
        if (typeof value.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at)) out.at = value.at;
        for (const role of ["gateway", "rtc"]) {
            out[role] = {};
            for (const key of ["attempts", "opened", "active", "failed", "closed", "lastConnectMs", "lastCloseCode"]) {
                const n = value[role]?.[key];
                out[role][key] = typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e12 ? Math.round(n * 100) / 100 : null;
            }
        }
        return out;
    }

    saveRouteEvidence(value = this.sessionRoute?.evidence?.()) {
        const safe = this.sanitizeRouteEvidence(value);
        if (!safe) return;
        safe.at = new Date().toISOString(); safe.sessionOpened = value?.sessionOpened === true || this.routeSessionReady === true;
        this.lastRouteEvidence = safe;
        try { BdApi.Data.save(NAME, "lastRouteEvidence", safe); } catch {}
    }

    routeEvidenceSummary(value) {
        const safe = this.sanitizeRouteEvidence(value);
        if (!safe) return "sem amostra";
        return `${safe.at ? safe.at + "; " : ""}backend=${safe.backend==='leap-openvpn-process'?providerLabel(safe.provider?.selected)+'/OpenVPN por processo':safe.backend==='riseup-openvpn'?'Riseup/OpenVPN global antigo':'Tor antigo'}; serviço=${safe.serviceStage||"?"}/${safe.serviceFailure||"?"}/nativo${safe.serviceNativeCode??"?"}; isolamento=${safe.isolationVerified}; etapa WFP=${safe.isolationStage||"?"}; erro WFP=${safe.isolationError??"?"}; conexão normal na verificação=${safe.normalRoutePreserved}; prova rotas=${safe.routeProof?.reason||"?"}/túnel=${safe.routeProof?.tunnelPresent??"?"}/normal=${safe.routeProof?.normalPreserved??"?"}/métrica=${safe.routeProof?.tunnelMetric??"?"}/rotas=${safe.routeProof?.ownRoutes??"?"}/controle=${safe.routeProof?.ignoredControlRoutes??"?"}; endereço VPN=${safe.addressState||"?"}; socket=${safe.proxyDiagnostic?.stage||"?"}/${safe.proxyDiagnostic?.category||"?"}/nativo${safe.proxyDiagnostic?.nativeCode??"?"}/tentativas${safe.proxyDiagnostic?.attempts??"?"}/endereços${safe.proxyDiagnostic?.addresses??"?"}; regras=${safe.processRuleCount}; TCP relay=${safe.tcpRelays}; UDP relay=${safe.udpRelays}; teste gateway=${safe.probe.stage||"?"}/${safe.probe.code||"?"}/HTTP${safe.probe.httpStatus??"?"}; país=${safe.country||"?"}; controlador=${safe.workerStage||"?"}; saída OpenVPN=${safe.nativeExitCode??"?"}; motivo=${safe.nativeReason||"?"}; sinais=${safe.nativeMarkers.join(",")||"nenhum"}; rota IPv4 verificada=${safe.routesVerified}; restauração confirmada=${safe.cleanupConfirmed}; modo=${safe.scope === "rtc" ? "gateway+RTC-controle" : "gateway"}; sessão aberta=${safe.sessionOpened}; portas RTC observadas=${safe.rtcPorts.join(",") || "nenhuma"}; portas fora da rota=${safe.unroutedRtcPorts.join(",") || "nenhuma"}; ` +
            ["gateway", "rtc"].map(role => `${role}{tentativas=${safe[role].attempts}; abertas=${safe[role].opened}; ativas=${safe[role].active}; falhas=${safe[role].failed}; fechadas=${safe[role].closed}; conexão_ms=${safe[role].lastConnectMs}; último código=${safe[role].lastCloseCode}}`).join("; ");
    }

    sessionSocket() {
        const store = this.getStore("GatewayConnectionStore") || this.getModule(m =>
            typeof m?.getSocket === "function" && typeof m?.isConnected === "function");
        const socket = store?.getSocket?.();
        return socket && ["close", "connect", "isSessionEstablished"].every(key => typeof socket[key] === "function") &&
            Function.prototype.toString.call(socket.close).includes("sessionId") ? socket : null;
    }

    newSessionTransport(onStatus) {
        try {
            const path = require("path"), fs = require("fs"), crypto = require("crypto"), electron = require("electron");
            if (typeof BdApi.Net?.fetch !== "function" || typeof electron.shell?.openPath !== "function")
                throw Object.assign(new Error("API indisponível"), {code:"CS_BD_API"});
            return new SessionClient({root: runtimeForVersion(fs,path,BdApi.Plugins.folder,VERSION), onStatus, scope:"rtc",
                onEvidence:(role,event,evidence) => {
                    if (!this.running) return;
                    this.saveRouteEvidence(evidence);
                    this.record("rota WebSocket", `tipo=${role === "gateway" ? "gateway" : "RTC-controle"}; evento=${["tentativa","aberto","erro","fechado","porta fora da rota"].includes(event) ? event : "desconhecido"}; ${this.routeEvidenceSummary(evidence)}`);
                }, path, fs, crypto, fetch: BdApi.Net.fetch.bind(BdApi.Net), launch: file => electron.shell.openPath(file)});
        } catch (error) { throw Object.assign(new Error("API nativa do BetterDiscord indisponível"), {code:"CS_BD_API"}); }
    }

    checkInstallation(notify=false) {
        this.setupCheckedAt=Date.now();
        let state;
        try {
            state=inspectInstallation({fs:require('fs'),path:require('path'),folder:BdApi.Plugins.folder,
                programFiles:typeof process==='undefined'?null:process.env?.ProgramW6432||process.env?.ProgramFiles,
                version:VERSION,serviceVersion:BACKEND_VERSION});
        } catch { return; }
        if(state==='unconfirmed' && this.sessionRoute?.lastVerifiedAt)state='ready';
        this.setupState=state;
        if(notify && setupNotices[state] && this.setupAnnounced!==state){
            this.setupAnnounced=state;
            this.toast('CallShare · '+setupNotices[state],'warning');
        }
        this.renderMaintenance();
    }

    renderMaintenance() {
        const text=(node,value)=>{if(node && node.textContent!==value)node.textContent=value;};
        if(this.setupNotice){
            const state=this.setupState, message=setupNotices[state];
            this.setupNotice.hidden=!message;
            text(this.setupText,message||'');
            this.setupAction.hidden=!message||state==='package';
            text(this.setupAction,state==='upgrade'?'Atualizar auxiliar':'Instalar auxiliar');
            this.setupAction.disabled=!this.canInstallNativeHelper();
        }
        const available=this.feed && this.feedCache?.url===this.feed && newerRelease(this.feedCache.version,VERSION);
        if(this.releaseNotice){
            this.releaseNotice.hidden=!available&&!this.packageMessage;
            const busy=this.voiceChannelId()||!this.canInstallNativeHelper();
            text(this.releaseText,this.packageMessage||(available?'CallShare '+this.feedCache.version+' disponível.'+(busy?' Saia da call para atualizar.':''):''));
            this.updateButton.hidden=!available||this.feed!==PROJECT_FEED;
            this.updateButton.disabled=!!(this.packageJob||busy);
        }
        text(this.feedStatus,this.feedMessage || (this.feed?'Aviso automático uma vez por dia.':'Consulta automática desativada.'));
    }

    announceRelease() {
        const latest=this.feedCache?.version;
        if(this.feed!==PROJECT_FEED || this.feedCache?.url!==PROJECT_FEED || !newerRelease(latest,VERSION) || latest===this.releaseNoticeVersion)return;
        this.releaseNoticeVersion=latest;
        this.dismissReleaseNotice?.();
        if(typeof BdApi.UI.showNotice==='function'){
            const dismiss=BdApi.UI.showNotice('CallShare '+latest+' disponível.',{type:'info',buttons:[{label:'Atualizar',onClick:()=>this.installPackageUpdate()}]});
            this.dismissReleaseNotice=typeof dismiss==='function'?dismiss:null;
        }else this.toast('CallShare '+latest+' disponível. Abra o painel e clique em Atualizar.');
    }

    async installPackageUpdate() {
        if(!this.running||this.packageJob||this.feed!==PROJECT_FEED||this.feedCache?.url!==PROJECT_FEED||!newerRelease(this.feedCache.version,VERSION))return;
        if(this.voiceChannelId()||!this.canInstallNativeHelper())return this.toast('Saia da call e aguarde o túnel encerrar para atualizar.','warning');
        const job={},generation=this.generation;
        const current=()=>this.running&&generation===this.generation&&this.packageJob===job;
        const finish=(message,success=false)=>{
            if(!current())return;
            clearInterval(this.packageTimer);this.packageJob=null;this.packageMessage=message;
            if(!success)BdApi.Data.save(NAME,'applyingVersion',null);
            this.renderMaintenance();if(!success)this.toast(message,'warning');
            if(success)BdApi.Plugins.reload?.(NAME);
        };
        this.packageJob=job;this.packageMessage='Preparando atualização…';this.renderMaintenance();
        try{
            const fs=require('fs'),path=require('path'),crypto=require('crypto'),electron=require('electron');
            const folder=BdApi.Plugins.folder,base=path.join(folder,'CallShare-runtime');
            const file=path.join(runtimeForVersion(fs,path,folder,VERSION),'CallShare-update.exe');
            if(crypto.createHash('sha256').update(fs.readFileSync(file,null)).digest('hex')!=='__CALLSHARE_UPDATE_SHA256__')throw Error();
            const id=Array.from(crypto.randomBytes(16),byte=>byte.toString(16).padStart(2,'0')).join('');
            const request=path.join(base,'update-request.json'),temp=request+'.'+id+'.tmp';
            fs.writeFileSync(temp,JSON.stringify({id,version:this.feedCache.version}));fs.renameSync(temp,request);
            BdApi.Data.save(NAME,'applyingVersion',this.feedCache.version);
            const result=await electron.shell.openPath(file);
            if(result)throw Error();
            if(!current())return;
            const start=Date.now();
            const progress={checking:'Conferindo a versão publicada…',downloading:'Baixando o pacote…',verifying:'Verificando a integridade do pacote…',installing:'Aplicando a atualização…'};
            this.packageTimer=setInterval(()=>{
                if(!current())return;
                let status;try{status=smallReleaseFile(fs,path.join(base,'update-status.json'));}catch{}
                if(status?.id===id){
                    if(status.phase==='done')return finish('CallShare atualizado.',true);
                    if(status.phase==='busy')return finish('O auxiliar ainda está em uso. Tente atualizar após ele encerrar.');
                    if(status.phase==='failed')return finish('A atualização não foi concluída. Você pode tentar novamente.');
                    if(progress[status.phase]){this.packageMessage=progress[status.phase];this.renderMaintenance();}
                }
                if(Date.now()-start>600000)finish('Sem confirmação do atualizador. Confira a versão do plugin antes de tentar novamente.');
            },1000);
        }catch{finish('Não foi possível abrir o atualizador verificado. Confira o runtime desta instalação.');}
    }

    appendUpdateSettings(parent) {
        const details=this.element('details'), input=this.element('input');
        details.append(this.element('summary','Avisos de novas versões'));
        input.type='url';input.className='cs-feed';input.value=this.feed||'';input.placeholder='https://…/release.json';
        input.setAttribute('aria-label','Endereço HTTPS do arquivo de versões do CallShare');
        const save=this.button('Salvar canal',()=>{
            const url=releaseFeedUrl(input.value);
            if(input.value.trim()&&!url){this.toast('Informe o endereço HTTPS do arquivo de versões.','warning');return;}
            if(url!==this.feed){
                this.dismissReleaseNotice?.();this.dismissReleaseNotice=null;this.releaseNoticeVersion=null;
                this.feed=url;this.feedCache={};this.feedMessage='';this.feedTask=null;clearTimeout(this.feedTimer);
                BdApi.Data.save(NAME,'updateFeed',url);BdApi.Data.save(NAME,'updateCheck',{});
            }
            if(url)this.checkRelease(true);else this.renderMaintenance();
        });
        const check=this.button('Verificar agora',()=>{
            this.checkInstallation();
            if(this.feed)this.checkRelease(true);else this.toast('Salve o endereço do canal para consultar novas versões.');
        });
        this.feedStatus=this.element('p',null,'cs-muted');this.feedStatus.setAttribute('role','status');
        const actions=this.element('div',null,'cs-actions');actions.append(save,check);
        details.append(input,actions,this.feedStatus);parent.append(details);
    }

    async checkRelease(manual=false) {
        const url=this.feed, generation=this.generation, day=86400000;
        if(!url||this.feedTask)return;
        const cached=this.feedCache?.url===url?this.feedCache:{};
        const age=Date.now()-cached.checkedAt;
        const schedule=ms=>{
            clearTimeout(this.feedTimer);
            this.feedTimer=setTimeout(()=>this.checkRelease(),ms);
        };
        if(!manual && age>=0 && age<day){schedule(day-age);this.renderMaintenance();this.announceRelease();return;}
        const request={};
        this.feedTask=request;this.feedMessage='Consultando versões…';this.renderMaintenance();
        const current=()=>this.running&&generation===this.generation&&this.feed===url&&this.feedTask===request;
        try {
            const response=await BdApi.Net.fetch(url,{method:'GET',timeout:6000,redirect:'error',credentials:'omit',cache:'no-store'});
            if(response.status!==200||Number(response.headers?.get?.('content-length'))>4096)throw Error();
            const raw=await response.text();
            if(raw.length>4096)throw Error();
            const {version}=JSON.parse(raw);
            if(!releaseNumber(version))throw Error();
            if(!current())return;
            this.feedCache={url,version,checkedAt:Date.now()};
            this.announceRelease();
            this.feedMessage=newerRelease(version,VERSION)?'Disponível · '+version:'Você tem a versão mais recente deste canal.';
        }catch{
            if(!current())return;
            this.feedCache={...cached,url,checkedAt:Date.now()};
            this.feedMessage='Consulta indisponível. Você pode tentar novamente.';
        }finally{
            if(current()){
                this.feedTask=null;BdApi.Data.save(NAME,'updateCheck',this.feedCache);schedule(day);this.renderMaintenance();
            }
        }
    }

    canInstallNativeHelper() {
        return !this.packageJob&&!this.sessionRoute&&!this.routeDisableBusy&&!this.routeSwitchBusy&&!this.autoBusy;
    }

    async installNativeHelper() {
        if(!this.canInstallNativeHelper())return this.toast('Pause o CallShare e aguarde o túnel encerrar antes de instalar ou reparar o auxiliar.','warning');
        try { const fs=require("fs"),path=require("path"),crypto=require("crypto"),electron=require("electron");
            const file=path.join(runtimeForVersion(fs,path,BdApi.Plugins.folder,VERSION),"CallShare-install.exe");
            if(!fs.existsSync(file)||crypto.createHash("sha256").update(fs.readFileSync(file,null)).digest("hex")!=="__CALLSHARE_INSTALL_SHA256__")throw Error();
            const result=await electron.shell.openPath(file);if(typeof result==="string"&&result)throw Error();
            if(!this.running)return;
            if(this.afterInstaller)window.removeEventListener?.('focus',this.afterInstaller);
            this.afterInstaller=()=>{if(this.running)this.checkInstallation();};
            window.addEventListener?.('focus',this.afterInstaller,{once:true});
            this.toast("Conclua a instalação autorizada pelo Windows. Depois volte ao painel e use a ação de preparar no painel.");
        } catch { this.toast(`Não foi possível abrir o instalador verificado. Copie o pacote completo ${VERSION}.`,"warning"); }
    }

    async enableSessionRoute(preserveVoice=false,{automatic=false,allowStreams=false,standby=false}={}) {
        if (!this.running || this.sessionRoute || this.packageJob) return;
        this.syncConnectionHooks();
        const plan=preserveVoice?this.routeDiagnostics.plan({allowStreams,allowPendingStreams:standby}):null;
        if(plan)plan.channel=this.voiceChannelId();
        if(preserveVoice&&(!this.voiceChannelId()||!plan?.eligible))return this.toast("Para este teste, entre na call, aguarde a voz conectar e encerre transmissões que esteja enviando ou assistindo. O endereço da voz precisa estar identificado no relatório.",'warning');
        if (!preserveVoice&&this.voiceChannelId()) return this.toast("O modo completo precisa ser preparado fora da call. Para testar dentro dela, use Preparar na call · testar voz direta.", "warning");
        if (!preserveVoice&&!this.sessionSocket()) return this.toast("Não foi possível identificar a reconexão de sessão nesta versão do Discord.", "warning");
        const generation = this.generation;
        this.routeProgress=[];this.progressStartedAt=Date.now();
        let route;
        try {
            route = this.newSessionTransport(value => {
                if (!this.running || generation !== this.generation || this.sessionRoute !== route) return;
                this.updateRouteStatus(value);
                this.record("rota de sessão", value);
            });
            this.sessionRoute = route;
            this.voiceRouteReady=false;this.routeWarmReady=false;this.lastRouteFailure=null;
            this.routeMode=preserveVoice?'voice-direct':'full';
            this.voicePreservation=preserveVoice?plan:null;
            this.routeDiagnostics.event(preserveVoice?'prepare-voice':'prepare-full');
            this.saveRouteEvidence();
            await route.start(preserveVoice?{voiceBypass:plan.voice,...(standby?{standby:true}:{})}:{});
            if (!this.running || generation !== this.generation || this.sessionRoute !== route) { route.stop()?.catch?.(()=>{}); return; }
            this.setupState='ready';this.renderMaintenance();
            if(preserveVoice){
                this.syncConnectionHooks();
                if(this.voicePreservation!==plan)throw Object.assign(new Error('CS_VOICE_ENDPOINT'),{code:'CS_VOICE_ENDPOINT'});
                const proof=route.lastStatus?.network?.voicePass;
                if(!proof?.verified||proof.requested?.ip!==plan.voice.ip||proof.requested?.port!==plan.voice.port)throw Object.assign(new Error('CS_VOICE_FILTER'),{code:'CS_VOICE_FILTER'});
                if(standby){
                    if(route.lastStatus?.standbyVerified!==true||route.lastStatus?.routingActive!==false)throw Object.assign(new Error('CS_PROCESS_ROUTER'),{code:'CS_PROCESS_ROUTER'});
                    this.routeWarmReady=true;this.revealNativeControls();this.routeMode='standby';this.phase='túnel em espera';
                    this.captureRouteDiagnostics();this.updateRouteStatus('Túnel em espera. Discord na conexão normal.');
                    this.record('espera pronta; encaminhamento do Discord desligado');return;
                }
                route.installWebSocket(window);
                this.voiceRouteReady=true;this.revealNativeControls();
                this.phase='voz direta ativa';this.routeSessionReady=false;
                this.captureRouteDiagnostics();
                this.updateRouteStatus('Conexão ativa. Voz direta; transmissões preparadas.');
                this.record('preparação dentro da call sem reconexão de sessão',`destino de voz preservado; ${plan.id}`);
                this.toast(automatic?'CallShare ativo. Preparação automática concluída.':'CallShare ativo para transmitir e assistir. Voz na conexão normal.');
                return;
            }
            if (this.voiceChannelId()) throw new Error("Saia da call e prepare novamente.");
            const socket = this.sessionSocket();
            if (!socket) throw new Error("Reconexão de sessão indisponível.");
            route.installWebSocket(window);
            this.routeSessionReady = false;
            this.voiceRouteReady=false;
            this.phase="VPN integrada";
            this.updateRouteStatus("reconectando a sessão pela VPN integrada");
            this.record("reconexão de sessão solicitada pela VPN integrada");
            socket.close();
            // close() schedules native reset on the next event-loop turn.
            const timer = setTimeout(() => {
                this.pending.delete(timer);
                if (!this.running || this.sessionRoute !== route || route.stopped) return;
                try { socket.connect(); }
                catch { this.disableSessionRoute(); this.toast("O Discord não aceitou a reconexão pela rota.", "warning"); }
            }, 150);
            this.pending.add(timer);
            this.toast("VPN preparada. Aguarde a nova sessão antes de entrar na call.");
        } catch (error) {
            const cancelled = !this.running || generation !== this.generation || route?.stopped || (route && this.sessionRoute !== route);
            if(this.generation===generation&&this.sessionRoute===route){this.voiceRouteReady=false;this.routeWarmReady=false;}
            let clean=true;try{await route?.stop();}catch{clean=false;}
            if (cancelled) return;
            this.saveRouteEvidence(route?.evidence?.());
            if(clean)this.sessionRoute = null;
            if(clean){this.routeMode='off';this.voicePreservation=null;}
            this.routeSessionReady = false;
            const messages = {
                CS_SERVICE_MISSING:"Instale o auxiliar uma vez pelo botão Instalar/atualizar auxiliar.",CS_SERVICE_ACCESS:"O serviço não concedeu acesso à sua conta do Windows. Reinstale o auxiliar.",
                CS_SERVICE_AUTH:"O serviço recusou a identificação local. Atualize o auxiliar e copie o relatório se persistir.",CS_SERVICE_START:"O Windows não iniciou o serviço. Atualize o auxiliar e copie o relatório.",
                CS_SERVICE_PIPE:"O serviço não abriu sua comunicação local. Copie o relatório.",CS_SERVICE_INPUT:"O serviço não reconheceu a solicitação do auxiliar.",CS_SERVICE_LAUNCH:"O serviço respondeu, mas não conseguiu abrir o controlador. Copie o relatório.",
                CS_SERVICE_BUSY:"Outra preparação do auxiliar ainda está em andamento.",CS_SERVICE_UNAVAILABLE:"O serviço instalado não respondeu.",CS_SERVICE_PROTOCOL:"O serviço instalado é de outra versão. Abra Avançado e use Instalar/atualizar auxiliar.",
                CS_ISOLATION_BASELINE:"Não foi possível identificar uma saída normal IPv4 para preservar.",CS_ISOLATION_WFP:"O Windows não confirmou a proteção da interface de rede.",CS_ISOLATION_ROUTES:"A rota do Discord ou a preservação da conexão normal não foi confirmada.",
                CS_VOICE_ENDPOINT:"O destino da voz não foi confirmado ou mudou durante a preparação. Aguarde a call estabilizar e tente novamente.",
                CS_VOICE_FILTER:"O Windows não confirmou a exceção direta da voz. O teste foi encerrado; copie o relatório.",
                CS_DISCORD_PROCESS:"O serviço não encontrou o processo do Discord desta conta.",CS_UDP_OWNER_TABLE:"O serviço não conseguiu consultar os responsáveis pelas conexões UDP.",CS_PROCESS_DRIVER:"O driver de isolamento ainda não está disponível. Confira a instalação do auxiliar.",CS_PROCESS_DRIVER_BUSY:"Outro filtro já está usando esse driver. Encerre essa outra conexão antes de preparar.",CS_PROCESS_ROUTER:"Não foi possível ativar o filtro por aplicativo. Confira a instalação do auxiliar e copie o relatório.",CS_PROCESS_CLEANUP:"O filtro por aplicativo não confirmou o encerramento.",
                CS_VPN_ADDRESS_NOT_READY:"O endereço da VPN ainda não ficou utilizável no Windows. Copie o relatório.",
                CS_PROXY_BIND:"O Windows não aceitou a abertura local da conexão na interface VPN. Copie o relatório.",CS_PROXY_SOCKET:"O auxiliar falhou ao abrir a conexão pelo túnel. O relatório inclui a etapa e o erro do Windows.",
                CS_PROXY_DENIED:"O Windows ou uma regra de rede negou a saída pelo túnel. Copie o relatório.",CS_PROXY_INTERFACE:"O Windows não confirmou a interface escolhida para o túnel. Copie o relatório.",CS_PROXY_LOCAL_ADDRESS:"O endereço local do túnel não estava disponível para essa conexão. Copie o relatório.",
                CS_PROBE_NETWORK_UNREACHABLE:"A conexão pelo túnel não encontrou uma rota de rede para o gateway.",CS_PROBE_HOST_UNREACHABLE:"O gateway não pôde ser alcançado pelo túnel. Copie o relatório.",
                CS_PROBE_DNS:"A rota conectou, mas o nome do gateway não foi resolvido.",CS_PROBE_CONNECT:"O auxiliar não abriu a conexão local de teste.",CS_PROBE_TIMEOUT:"O teste do gateway excedeu o prazo.",CS_PROBE_REFUSED:"A conexão TCP ao gateway foi recusada.",CS_PROBE_TARGET:"A rota não abriu a conexão TCP ao gateway.",CS_PROBE_TLS:"O teste TLS do gateway falhou.",CS_PROBE_HTTP:"A troca WebSocket do gateway não foi confirmada. O relatório inclui o código HTTP quando disponível.",CS_PROXY_AUTH:"A autenticação do proxy local falhou.",CS_PROXY_PROTOCOL:"O proxy local respondeu com um formato inesperado.",CS_PROXY_NOT_READY:"O proxy isolado ainda não está disponível.",
                CS_BD_API:"A API necessária do BetterDiscord não está disponível nesta versão.",
                CS_HELPER_BUSY:"O auxiliar anterior ainda está encerrando. Aguarde e use Reconectar.",
                CS_HELPER_MISSING:`Auxiliar ausente. Copie a pasta CallShare-runtime completa do pacote ${VERSION}.`,
                CS_HELPER_READ:"O BetterDiscord não conseguiu ler o auxiliar integrado.",
                CS_HELPER_HASH:`O auxiliar diverge do arquivo esperado. Copie novamente o pacote completo ${VERSION}.`,
                CS_HELPER_LAUNCH:"O Windows não conseguiu abrir o auxiliar integrado.",
                CS_HELPER_TIMEOUT:"O auxiliar não respondeu em 15 segundos.",
                CS_HELPER_CONTROL:"A comunicação local com o auxiliar falhou.",
                CS_HELPER_PROTOCOL:"O auxiliar respondeu com uma versão ou formato incompatível.",
                CS_GATEWAY_PROBE:"A VPN conectou, mas o gateway do Discord não aceitou a conexão de teste.",
                CS_BRIDGE:"Não foi possível preparar a ponte local do gateway.",
                CS_WEBSOCKET:"Não foi possível ligar a ponte ao WebSocket do Discord.",
                CS_PROVIDER_NETWORK:"Não foi possível consultar o serviço gratuito.",CS_PROVIDER_CA:"O certificado do provedor não foi validado.",
                CS_PREPARE_TIMEOUT:"O preparo atingiu o prazo total. A conexão está sendo restaurada antes de uma nova tentativa.",CS_PROVIDER_TIMEOUT:"A tentativa com o provedor excedeu o tempo de espera.",CS_PROVIDER_SIZE:"A resposta do provedor excedeu o limite esperado.",CS_PROVIDER_FORMAT:"O provedor retornou um formato inesperado.",
                CS_PROVIDER_IDENTITY:"Não foi possível validar a identidade temporária da VPN.",CS_PROVIDER_HTTP:"O serviço gratuito não respondeu como esperado.",
                CS_WORKER_UAC:"O controlador não foi autorizado pelo Windows ou não abriu a tempo.",CS_WORKER_HASH:"O controlador de rede não corresponde a este pacote.",
                CS_WORKER_MISSING:"O controlador de rede está ausente. Copie o pacote completo.",CS_WORKER_TOOL:"O Windows recusou a preparação do driver ou adaptador de rede.",
                CS_WORKER_TOOL_TIMEOUT:"O Windows não terminou a operação de rede dentro do prazo.",
                CS_WORKER_PROTOCOL:"O controlador respondeu com um formato incompatível.",
                CS_WORKER_RUNTIME:"Um componente de rede protegido está ausente ou foi alterado.",
                CS_WORKER_DIRECTORY:"O diretório protegido dos componentes de rede não passou pela verificação.",
                CS_WORKER_ADAPTER:"Não foi possível identificar o adaptador temporário criado.",
                CS_WORKER_JOB:"O Windows não aceitou o controle de encerramento do processo de rede.",
                CS_WORKER_UNAVAILABLE:"O controlador de rede não respondeu.",CS_VPN_TLS:"O servidor VPN não passou pela verificação de certificado.",
                CS_VPN_CONFIG:"O OpenVPN recusou uma opção da configuração integrada.",CS_VPN_AUTH:"O servidor recusou a identidade temporária.",
                CS_VPN_IDENTITY:"O OpenVPN não conseguiu carregar o certificado ou a chave temporária.",
                CS_VPN_ADAPTER:"O OpenVPN não conseguiu encontrar ou abrir o adaptador criado.",CS_VPN_DCO:"O driver não aceitou uma operação da VPN.",
                CS_VPN_DRIVER_NOT_READY:"O driver ou adaptador ainda não ficou disponível no Windows. Copie o relatório antes de tentar novamente.",
                CS_VPN_TIMEOUT:"Os servidores VPN não conectaram dentro do prazo.",CS_VPN_ROUTES:"A rota IPv4 pela VPN não foi confirmada.",
                CS_VPN_EXIT:"O transporte VPN foi encerrado.",CS_VPN_CLEANUP:"A restauração da rede ainda não foi confirmada.",
                CS_HELPER_INTERNAL:"O auxiliar encontrou uma falha interna.",
                CS_ROUTE_UNKNOWN:"A preparação falhou em uma etapa não identificada."
            };
            const code = Object.hasOwn(messages,error?.code) ? error.code : "CS_ROUTE_UNKNOWN";
            this.lastRouteFailure=code;
            const routeMessage=code==="CS_ISOLATION_ROUTES"?{
                "tunnel-default-missing":"A VPN conectou, mas a rota de saída do túnel não foi encontrada.",
                "tunnel-metric-too-low":"Não foi possível manter a rota do túnel com prioridade menor que a conexão normal.",
                "normal-default-changed":"A rota normal mudou durante a preparação, que foi encerrada.",
                "normal-prefix-conflict":"Foi detectado um conflito entre o túnel e uma rota da sua rede.",
                "read-failed":"Não foi possível ler as rotas do Windows. Copie o relatório."
            }[this.lastRouteEvidence?.routeProof?.reason]:null;
            this.updateRouteStatus(`falha ${code}; ${clean?"restauração concluída":"restauração não confirmada"}`);
            if(['CS_HELPER_HASH','CS_HELPER_MISSING','CS_HELPER_PROTOCOL'].includes(code))this.setupState='package';
            if(code==='CS_SERVICE_MISSING')this.setupState='install';
            if(code==='CS_SERVICE_PROTOCOL'||code==='CS_WORKER_PROTOCOL')this.setupState='upgrade';
            this.renderMaintenance();
            this.record("preparação da rota falhou",code);
            if(!automatic)this.toast(`${routeMessage||messages[code]} Código: ${code}. ${clean?"A preparação foi encerrada.":"Use Voltar à conexão normal e copie o relatório."}`, "warning");
        }
    }

    async disableSessionRoute({reason='manual'}={}) {
        if(reason==='manual'){this.bootstrap?.cancel();this.manualDemandCall=null;this.autoPolicy?.pause(this.voiceChannelId());}
        if(reason==='endpoint-overlap')this.autoPolicy?.fail('CS_VOICE_OVERLAP');
        const route = this.sessionRoute;
        if(!route||this.routeDisableBusy){this.tickAutomatic();this.updateToolbar();return;}
        route.callshareCancelled=true;
        this.voiceRouteReady=false;this.routeWarmReady=false;
        const generation=this.generation,sessionOpened=this.routeSessionReady;
        this.routeDisableBusy=true;
        this.captureRouteDiagnostics();
        this.voicePreservation=null;
        this.saveRouteEvidence();
        this.routeSessionReady = false;
        this.updateRouteStatus("restaurando a conexão normal; aguarde");
        try{
            await route.stop();
            if(this.generation!==generation||this.sessionRoute!==route)return;
            this.captureRouteDiagnostics();
            this.saveRouteEvidence({...route.evidence?.(),sessionOpened});
            if(this.sessionRoute===route)this.sessionRoute=null;
            this.routeMode='off';this.routeDiagnostics?.event('restore');
            this.phase="conexão normal após VPN integrada";
            this.updateRouteStatus("conexão normal restaurada");
            if(this.running){this.record("rota integrada desligada; restauração confirmada");this.toast(reason==='bootstrap-complete'?"CallShare: túnel desligado. Verificando a tela na conexão normal.":"Conexão normal restaurada. Confira se a imagem continua chegando.");}
        }catch{
            this.updateRouteStatus("restauração não confirmada; aguarde o controlador e copie o relatório");
            if(this.running){this.record("restauração não confirmada","CS_VPN_CLEANUP");this.toast("O controlador ainda não confirmou a restauração. Copie o relatório.","warning");}
        }finally{if(this.generation===generation){this.routeDisableBusy=false;this.tickAutomatic();this.updateToolbar();}}
    }

    getSettingsPanel() {
        const panel = this.element("div");
        panel.append(this.element("p", "Compartilhamento nativo com rota por aplicativo. Instale o auxiliar uma vez; as preparações seguintes não pedem nova autorização. Ainda é experimental."),
            this.button("Abrir painel do CallShare", () => this.showPanel()));
        return panel;
    }
};
