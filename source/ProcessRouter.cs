// Original adapter for the separately licensed ProxiFyre engine. Combined worker: AGPL-3.0.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

internal sealed class ProcessRouter : IDisposable {
    object instance;
    MethodInfo stop;
    MethodInfo start;
    bool started;
    bool routingActive;
    bool observingSdkLogs;
    int sdkUdpStartFailures;
    PacketModeGate modeGate;
    Func<PacketModeGate> gateFactory=delegate{return new PacketModeGate(new NativeAdapterModes());};
    VoicePass voicePass;
    public int RuleCount;
    public int EngineStarts,Pauses,Resumes;
    public bool Active {get{return routingActive;}}
    public object Lifecycle {get{return new {strategy="adapter-modes-keep-udp",engineStarts=EngineStarts,pauses=Pauses,resumes=Resumes,activeAdapters=modeGate==null?0:modeGate.ActiveAdapters,paused=StandbyVerified,
        sdkUdpStartFailures=observingSdkLogs?(int?)Volatile.Read(ref sdkUdpStartFailures):null};}}
    public bool StandbyVerified {get;private set;}
    public object VoiceProof {get{return voicePass==null?null:voicePass.Inspect();}}
    public bool VoiceVerified {get{return voicePass==null||voicePass.Inspect().verified;}}
    public void Start(string directory,List<string> targets,int port,string password,string voiceIp=null,int voicePort=0,bool activate=true){
        try{
            if(!SetDefaultDllDirectories(0xA00))throw new Exception();
            foreach(string dll in new[]{"MSVCP140.dll","MSVCP140_ATOMIC_WAIT.dll","VCRUNTIME140.dll","VCRUNTIME140_1.dll"})
                if(LoadLibraryEx(Path.Combine(Environment.SystemDirectory,dll),IntPtr.Zero,0x800)==IntPtr.Zero)throw new Exception();
            var assembly=Assembly.LoadFrom(Path.Combine(directory,"socksify.dll"));
            var type=assembly.GetType("Socksifier.Socksifier",true);
            var level=assembly.GetType("Socksifier.LogLevel",true);
            var protocols=assembly.GetType("Socksifier.SupportedProtocolsEnum",true);
            var families=assembly.GetType("Socksifier.SupportedAddressFamiliesEnum",true);
            instance=type.GetMethod("GetInstance",new[]{level,typeof(bool)}).Invoke(null,new[]{Enum.Parse(level,"Error"),(object)true});
            ObserveSdkLogs(type);
            stop=type.GetMethod("Stop",Type.EmptyTypes);
            start=type.GetMethod("Start",Type.EmptyTypes);
            type.GetMethod("SetBypassLan",Type.EmptyTypes).Invoke(instance,null);
            var add=type.GetMethod("AddSocks5Proxy",new[]{typeof(string),typeof(string),typeof(string),protocols,families,typeof(bool)});
            IntPtr proxy=(IntPtr)add.Invoke(instance,new object[]{"127.0.0.1:"+port,"callshare",password,Enum.Parse(protocols,"BOTH"),Enum.Parse(families,"IPv4"),false});
            if(proxy==new IntPtr(-1))throw new Exception();
            var associate=type.GetMethod("AssociateProcessNameToProxy",new[]{typeof(string),typeof(IntPtr)});
            foreach(string path in targets){
                // Never configure a catch-all, a process name wildcard or an arbitrary client path.
                if(String.IsNullOrEmpty(path)||path.IndexOf('*')>=0||path.IndexOf(';')>=0||path.IndexOf(',')>=0||!Path.IsPathRooted(path)||!path.EndsWith("\\Discord.exe",StringComparison.OrdinalIgnoreCase))throw new Exception();
                if(!(bool)associate.Invoke(instance,new object[]{path,proxy}))throw new Exception();RuleCount++;
            }
            if(voiceIp!=null){voicePass=new VoicePass(voiceIp,voicePort);voicePass.Install();}
            if(RuleCount==0)throw new Exception();
            if(activate)SetActive(true);else {DriverPreflight.AssertIdle(false);StandbyVerified=true;}
        }catch(Exception error){Dispose();throw new Exception(error.Message=="CS_VOICE_FILTER"||error.Message=="CS_VOICE_ENDPOINT"?error.Message:"CS_PROCESS_ROUTER");}
    }
    void ObserveSdkLogs(Type sdkType){
        try{
            var logEvent=sdkType.GetEvent("LogEvent");
            if(logEvent==null)return;
            var method=typeof(ProcessRouter).GetMethod("ReadSdkErrors",BindingFlags.Instance|BindingFlags.NonPublic);
            var handler=Delegate.CreateDelegate(logEvent.EventHandlerType,this,method,false);
            if(handler==null)return;
            logEvent.AddEventHandler(instance,handler);
            observingSdkLogs=true;
        }catch(Exception){/* Leave the counter unavailable if the SDK log interface is absent. */}
    }
    void ReadSdkErrors(object sender,EventArgs args){
        try{
            var property=args.GetType().GetProperty("Log");
            var entries=property==null?null:property.GetValue(args,null) as IEnumerable;
            if(entries==null)return;
            int inspected=0;
            foreach(var entry in entries){
                if(inspected++>=256)break;
                if(entry==null)continue;
                var description=entry.GetType().GetProperty("Description");
                var text=description==null?null:description.GetValue(entry,null) as string;
                if(text!=null&&text.IndexOf("Failed to start UDP proxy on port:",StringComparison.Ordinal)>=0)
                    Interlocked.Increment(ref sdkUdpStartFailures);
            }
        }catch(Exception){/* SDK logs must never interrupt the routing thread. */}
    }
    public void SetActive(bool value){
        if(instance==null)throw new Exception("CS_PROCESS_ROUTER");
        if(value==routingActive)return;
        StandbyVerified=false;
        if(value){
            if(!VoiceVerified)throw new Exception("CS_VOICE_FILTER");
            if(!started){
                if(start==null||!(bool)start.Invoke(instance,null))throw new Exception("CS_PROCESS_ROUTER");
                started=true;EngineStarts++;modeGate=gateFactory();
            }else modeGate.SetPaused(false);
            if(!VoiceVerified)throw new Exception("CS_VOICE_FILTER");
            routingActive=true;Resumes++;
        }else{
            // SDK Stop destroys UDP listeners; it is reserved for final cleanup.
            modeGate.SetPaused(true);routingActive=false;StandbyVerified=true;Pauses++;
        }
    }
    public void Dispose(){
        var owned=instance;if(owned==null)return;bool clean=true;
        try{if(started&&(stop==null||!(bool)stop.Invoke(owned,null)))clean=false;}catch{clean=false;}
        finally{
            // C++/CLI owns a foreground logging thread; Stop alone does not join it.
            // Always dispose the managed singleton, including configuration failures.
            try{var disposable=owned as IDisposable;if(disposable==null)throw new Exception();disposable.Dispose();}catch{clean=false;}
            instance=null;started=false;routingActive=false;
            if(modeGate!=null){modeGate.Dispose();modeGate=null;}
            if(voicePass!=null){voicePass.Dispose();voicePass=null;}
        }
        if(!clean)throw new Exception("CS_PROCESS_CLEANUP");
    }
    sealed class FakeLogArgs : EventArgs {
        public object[] Log {get;set;}
    }
    sealed class FakeEngine : IDisposable {
        internal int Starts,Stops;internal bool UdpAlive;internal PacketModeGate.FakeModes Modes;
        public bool Start(){Starts++;UdpAlive=true;Modes.Modes[11]=3;return true;}
        public bool Stop(){Stops++;UdpAlive=false;Modes.Modes[11]=0;return true;}
        public void Dispose(){}
        public event EventHandler<FakeLogArgs> LogEvent;
        public void Report(){
            if(LogEvent!=null)LogEvent(this,new FakeLogArgs{Log=new object[]{new {Description="other error"},new {Description="Failed to start UDP proxy on port: 1234"}}});
        }
    }
    public static void SelfTest(){
        var modes=new PacketModeGate.FakeModes();var engine=new FakeEngine{Modes=modes};var router=new ProcessRouter();
        router.instance=engine;router.start=typeof(FakeEngine).GetMethod("Start");router.stop=typeof(FakeEngine).GetMethod("Stop");
        router.ObserveSdkLogs(typeof(FakeEngine));engine.Report();
        if(!router.observingSdkLogs||router.sdkUdpStartFailures!=1)throw new Exception("SDK UDP error observation failed");
        router.gateFactory=delegate{return new PacketModeGate(modes);};
        for(int i=0;i<5;i++){router.SetActive(true);router.SetActive(false);if(!engine.UdpAlive||engine.Stops!=0||!router.StandbyVerified||modes.Modes[11]!=0)throw new Exception("UDP listener lost during standby");}
        if(engine.Starts!=1||router.EngineStarts!=1||router.Pauses!=5||router.Resumes!=5)throw new Exception("Router restarted between activations");
        router.Dispose();if(engine.Stops!=1||engine.UdpAlive)throw new Exception("Final router stop missing");
    }
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetDefaultDllDirectories(uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr LoadLibraryEx(string path,IntPtr file,uint flags);
}
