// Original CallShare policy. WFP objects are dynamic and limited to the owned interface.
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Reflection;
using System.IO;
using System.Diagnostics;
using System.Security.Principal;
using Microsoft.Win32;

internal sealed class SplitGuard : IDisposable {
    IntPtr engine;
    public static uint LastError;
    public static string LastStage;
    public readonly int InterfaceIndex;
    public readonly IPAddress LocalAddress;
    readonly uint baselineIndex;
    readonly List<Route> baseline;
    public SplitGuard(int index,IPAddress address) {
        InterfaceIndex=index;LocalAddress=address;baselineIndex=DefaultIndex();baseline=Routes();
        if(baselineIndex==0||baselineIndex==(uint)index)throw new Exception("CS_ISOLATION_BASELINE");
        StartFilter(index);
    }
    internal sealed class RouteProof {
        public bool inspected,tunnelPresent,normalPreserved;
        public string reason;
        public int ownRoutes,ignoredControlRoutes;
        public uint? tunnelMetric;
    }
    public volatile RouteProof LastRouteProof;
    static bool AffectsUnicast(Route row){
        // MIB IPv4 DWORDs contain address bytes in network order. On Windows x64,
        // the first octet occupies the low byte of the managed uint.
        return (row.Destination&255)<224;
    }
    static RouteProof EvaluateRoutes(IList<Route> before,IList<Route> current,uint baselineDefault,uint currentDefault,uint ownIndex){
        var proof=new RouteProof{inspected=true,normalPreserved=baselineDefault!=0&&currentDefault==baselineDefault&&currentDefault!=ownIndex};
        foreach(var row in current)if(row.Index==ownIndex){
            proof.ownRoutes++;
            if(!AffectsUnicast(row))proof.ignoredControlRoutes++;
            if(row.Destination==0&&row.Mask==0){
                if(!proof.tunnelMetric.HasValue||row.Metric<proof.tunnelMetric.Value)proof.tunnelMetric=row.Metric;
            }
        }
        proof.tunnelPresent=proof.tunnelMetric.HasValue&&proof.tunnelMetric.Value>=60000;
        if(!proof.normalPreserved){proof.reason="normal-default-changed";return proof;}
        foreach(var row in current)if(row.Index==ownIndex&&row.Mask!=0&&AffectsUnicast(row))
            foreach(var original in before)if(original.Index!=ownIndex&&original.Mask!=0&&AffectsUnicast(original)){
                // Use the shorter prefix to detect overlap in either direction.
                uint sharedMask=row.Mask&original.Mask;
                if((row.Destination&sharedMask)==(original.Destination&sharedMask)){
                    proof.normalPreserved=false;proof.reason="normal-prefix-conflict";return proof;
                }
            }
        proof.reason=proof.tunnelPresent?"verified":proof.tunnelMetric.HasValue?"tunnel-metric-too-low":"tunnel-default-missing";return proof;
    }
    public RouteProof InspectRoutes(){
        try{var proof=EvaluateRoutes(baseline,Routes(),baselineIndex,DefaultIndex(),(uint)InterfaceIndex);LastRouteProof=proof;return proof;}
        catch{LastRouteProof=new RouteProof{reason="read-failed"};throw;}
    }
    public static uint DefaultIndex(){
        Route row;uint ip=BitConverter.ToUInt32(IPAddress.Parse("1.1.1.1").GetAddressBytes(),0);
        return GetBestRoute(ip,0,out row)==0?row.Index:0;
    }
    public static List<Route> Routes(){
        int size=0;GetIpForwardTable(IntPtr.Zero,ref size,false);if(size<4||size>16*1024*1024)throw new Exception("CS_ISOLATION_ROUTES");
        IntPtr memory=Marshal.AllocHGlobal(size);try{
            if(GetIpForwardTable(memory,ref size,false)!=0)throw new Exception("CS_ISOLATION_ROUTES");
            int count=Marshal.ReadInt32(memory);if(count<0||count>(size-4)/56)throw new Exception("CS_ISOLATION_ROUTES");
            var rows=new List<Route>();for(int i=0;i<count;i++)rows.Add((Route)Marshal.PtrToStructure(IntPtr.Add(memory,4+i*56),typeof(Route)));return rows;
        }finally{Marshal.FreeHGlobal(memory);}
    }
    static void Check(uint result,string stage){LastStage=stage;if(result!=0){LastError=result;throw new Exception("CS_ISOLATION_WFP");}}
    static Session SessionDefinition(){return new Session{Key=Guid.NewGuid(),Flags=1,Display=new Display{Name="CallShare temporary session",Description="Owned Discord tunnel session"}};}
    static SubLayer SubLayerDefinition(){return new SubLayer{Key=Guid.NewGuid(),Weight=65535,Display=new Display{Name="CallShare tunnel isolation",Description="Rules limited to the owned tunnel interface"}};}
    static Filter FilterDefinition(Guid subLayer,IntPtr conditions){return new Filter{Key=Guid.NewGuid(),Layer=new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"),SubLayer=subLayer,
        Display=new Display{Name="CallShare block other tunnel applications",Description="Only the protected relay may open internet sockets on this interface"},
        Count=2,Conditions=conditions,Action=new ActionValue{Type=0x1001}};}
    void StartFilter(int index){
        // The worker is the sole process allowed to open internet sockets on this
        // interface. Other applications keep their preferred physical default route.
        var session=SessionDefinition();
        Check(FwpmEngineOpen0(null,10,IntPtr.Zero,ref session,out engine),"engine-open");
        IntPtr app=IntPtr.Zero,luid=IntPtr.Zero,conditions=IntPtr.Zero;
        try{
            var sub=SubLayerDefinition();Check(FwpmSubLayerAdd0(engine,ref sub,IntPtr.Zero),"sublayer-add");
            Check(FwpmGetAppIdFromFileName0(Assembly.GetExecutingAssembly().Location,out app),"app-id");
            ulong value;Check(ConvertInterfaceIndexToLuid((uint)index,out value),"interface-luid");
            luid=Marshal.AllocHGlobal(8);Marshal.WriteInt64(luid,unchecked((long)value));
            var interfaceCondition=new Condition{Key=new Guid("4cd62a49-59c3-4969-b7f3-bda5d32890a4"),Match=0,Value=new Value{Type=4,Pointer=luid}};
            var processCondition=new Condition{Key=new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971"),Match=10,Value=new Value{Type=12,Pointer=app}};
            int bytes=Marshal.SizeOf(typeof(Condition));conditions=Marshal.AllocHGlobal(bytes*2);
            Marshal.StructureToPtr(interfaceCondition,conditions,false);Marshal.StructureToPtr(processCondition,IntPtr.Add(conditions,bytes),false);
            var filter=FilterDefinition(sub.Key,conditions);
            ulong id;Check(FwpmFilterAdd0(engine,ref filter,IntPtr.Zero,out id),"filter-add");LastStage="ready";
        }catch{Dispose();throw;}
        finally{if(app!=IntPtr.Zero)FwpmFreeMemory0(ref app);if(luid!=IntPtr.Zero)Marshal.FreeHGlobal(luid);if(conditions!=IntPtr.Zero)Marshal.FreeHGlobal(conditions);}
    }
    public void Dispose(){if(engine!=IntPtr.Zero){FwpmEngineClose0(engine);engine=IntPtr.Zero;}}
    [StructLayout(LayoutKind.Sequential)]internal struct Route{public uint Destination,Mask,Policy,NextHop,Index,Type,Protocol,Age,As,Metric,Metric2,Metric3,Metric4,Metric5;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct Display{
        [MarshalAs(UnmanagedType.LPWStr)]public string Name;
        [MarshalAs(UnmanagedType.LPWStr)]public string Description;
    }
    [StructLayout(LayoutKind.Sequential)]struct Blob{public uint Size;public IntPtr Data;}
    [StructLayout(LayoutKind.Explicit,Size=16)]struct Value{[FieldOffset(0)]public uint Type;[FieldOffset(8)]public IntPtr Pointer;}
    [StructLayout(LayoutKind.Sequential)]struct Session{public Guid Key;public Display Display;public uint Flags,Timeout,Pid;public IntPtr Sid,User;public int Kernel;}
    [StructLayout(LayoutKind.Sequential)]struct SubLayer{public Guid Key;public Display Display;public uint Flags;public IntPtr Provider;public Blob Data;public ushort Weight;}
    [StructLayout(LayoutKind.Sequential)]struct Condition{public Guid Key;public uint Match;public Value Value;}
    [StructLayout(LayoutKind.Sequential)]struct ActionValue{public uint Type;public Guid Key;}
    [StructLayout(LayoutKind.Explicit,Size=16)]struct Context{[FieldOffset(0)]public ulong Raw;[FieldOffset(0)]public Guid Provider;}
    [StructLayout(LayoutKind.Sequential)]struct Filter{public Guid Key;public Display Display;public uint Flags;public IntPtr Provider;public Blob Data;
        public Guid Layer,SubLayer;public Value Weight;public uint Count;public IntPtr Conditions;public ActionValue Action;public Context Context;
        public IntPtr Reserved;public ulong Id;public Value EffectiveWeight;}
    [DllImport("iphlpapi.dll")]static extern uint GetBestRoute(uint destination,uint source,out Route row);
    [DllImport("iphlpapi.dll")]static extern uint GetIpForwardTable(IntPtr table,ref int size,bool ordered);
    [DllImport("iphlpapi.dll")]static extern uint ConvertInterfaceIndexToLuid(uint index,out ulong luid);
    [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)]static extern uint FwpmEngineOpen0(string server,uint authentication,IntPtr identity,ref Session session,out IntPtr engine);
    [DllImport("fwpuclnt.dll")]static extern uint FwpmEngineClose0(IntPtr engine);
    [DllImport("fwpuclnt.dll")]static extern uint FwpmSubLayerAdd0(IntPtr engine,ref SubLayer sub,IntPtr security);
    [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)]static extern uint FwpmGetAppIdFromFileName0(string file,out IntPtr app);
    [DllImport("fwpuclnt.dll")]static extern uint FwpmFilterAdd0(IntPtr engine,ref Filter filter,IntPtr security,out ulong id);
    [DllImport("fwpuclnt.dll")]static extern void FwpmFreeMemory0(ref IntPtr memory);
    static void CheckNativeDisplay(object definition){
        IntPtr memory=Marshal.AllocHGlobal(Marshal.SizeOf(definition));bool marshaled=false;
        try{
            Marshal.StructureToPtr(definition,memory,false);marshaled=true;
            // All three SDK structures have GUID followed by FWPM_DISPLAY_DATA0.
            IntPtr name=Marshal.ReadIntPtr(memory,16),description=Marshal.ReadIntPtr(memory,24);
            if(name==IntPtr.Zero||description==IntPtr.Zero||!Marshal.PtrToStringUni(name).StartsWith("CallShare ",StringComparison.Ordinal)||String.IsNullOrEmpty(Marshal.PtrToStringUni(description)))throw new Exception("WFP display data missing");
        }finally{if(marshaled)Marshal.DestroyStructure(memory,definition.GetType());Marshal.FreeHGlobal(memory);}
    }
    static Route TestRoute(uint index,string destination,string mask,uint metric){return new Route{Index=index,Destination=BitConverter.ToUInt32(IPAddress.Parse(destination).GetAddressBytes(),0),Mask=BitConverter.ToUInt32(IPAddress.Parse(mask).GetAddressBytes(),0),Metric=metric};}
    static void TestRouteComparison(){
        var before=new List<Route>{TestRoute(1,"0.0.0.0","0.0.0.0",25),TestRoute(1,"192.168.1.0","255.255.255.0",281),
            TestRoute(1,"224.0.0.0","240.0.0.0",281),TestRoute(1,"255.255.255.255","255.255.255.255",281),TestRoute(3,"127.0.0.0","255.0.0.0",331)};
        var active=new List<Route>(before){TestRoute(2,"0.0.0.0","0.0.0.0",65000),TestRoute(2,"10.8.0.0","255.255.255.0",5256),
            TestRoute(2,"10.8.0.2","255.255.255.255",5256),TestRoute(2,"224.0.0.0","240.0.0.0",5256),TestRoute(2,"255.255.255.255","255.255.255.255",5256)};
        var proof=EvaluateRoutes(before,active,1,1,2);
        if(!proof.normalPreserved||!proof.tunnelPresent||proof.reason!="verified"||proof.ignoredControlRoutes!=2||proof.tunnelMetric!=65000)throw new Exception("Route control-prefix regression");
        if(EvaluateRoutes(before,active,1,2,2).normalPreserved||EvaluateRoutes(before,active,1,3,2).normalPreserved)throw new Exception("Route default diversion accepted");
        var conflict=new List<Route>(active){TestRoute(2,"192.168.1.128","255.255.255.128",5256)};
        if(EvaluateRoutes(before,conflict,1,1,2).reason!="normal-prefix-conflict")throw new Exception("Route narrow LAN conflict accepted");
        conflict=new List<Route>(active){TestRoute(2,"192.168.0.0","255.255.0.0",5256)};
        if(EvaluateRoutes(before,conflict,1,1,2).reason!="normal-prefix-conflict")throw new Exception("Route broad LAN conflict accepted");
        var missing=new List<Route>(active);missing.RemoveAt(before.Count);
        proof=EvaluateRoutes(before,missing,1,1,2);if(proof.tunnelPresent||!proof.normalPreserved||proof.reason!="tunnel-default-missing")throw new Exception("Missing tunnel route accepted");
        active[before.Count]=TestRoute(2,"0.0.0.0","0.0.0.0",100);
        if(EvaluateRoutes(before,active,1,1,2).tunnelPresent)throw new Exception("Low-metric tunnel route accepted");
        active.Add(TestRoute(2,"0.0.0.0","0.0.0.0",65000));
        if(EvaluateRoutes(before,active,1,1,2).tunnelPresent)throw new Exception("Mixed low-metric tunnel routes accepted");
        // A retained failed proof must not be overwritten by evaluating cleanup's table.
        var failure=EvaluateRoutes(before,conflict,1,1,2);EvaluateRoutes(before,before,1,1,2);
        if(failure.normalPreserved||failure.reason!="normal-prefix-conflict")throw new Exception("Route failure snapshot changed");
    }
    public static void SelfTest(){
        TestRouteComparison();
        if(Marshal.SizeOf(typeof(Display))!=16||Marshal.SizeOf(typeof(Session))!=72||Marshal.SizeOf(typeof(SubLayer))!=72||Marshal.SizeOf(typeof(Condition))!=40||
            Marshal.SizeOf(typeof(Filter))!=200||Marshal.SizeOf(typeof(Route))!=56||Marshal.OffsetOf(typeof(Filter),"Context").ToInt32()!=152)throw new Exception("WFP ABI");
        var session=SessionDefinition();var sub=SubLayerDefinition();var filter=FilterDefinition(sub.Key,new IntPtr(1));
        CheckNativeDisplay(session);CheckNativeDisplay(sub);CheckNativeDisplay(filter);
        if(session.Flags!=1||sub.Weight!=65535||filter.SubLayer!=sub.Key||filter.Count!=2||filter.Action.Type!=0x1001)throw new Exception("WFP isolation policy changed");
        bool rejected=false;try{CheckNativeDisplay(new Filter());}catch(Exception error){rejected=error.Message=="WFP display data missing";}if(!rejected)throw new Exception("WFP empty display was not rejected");
        if(DefaultIndex()==0||Routes().Count==0)throw new Exception("Route table unavailable");
    }
}

internal static class DiscordTargets {
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr token);
    public static List<string> Find(string sid){
        string profile;using(var key=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\"+sid,false))profile=key==null?null:key.GetValue("ProfileImagePath") as string;
        if(String.IsNullOrEmpty(profile))throw new Exception("CS_DISCORD_PROCESS");
        string baseDir=Path.Combine(Environment.ExpandEnvironmentVariables(profile),@"AppData\Local\Discord");
        var result=new List<string>();
        foreach(var process in Process.GetProcessesByName("Discord"))using(process)try{
            IntPtr token;if(!OpenProcessToken(process.Handle,8,out token))continue;
            try{using(var identity=new WindowsIdentity(token)){if(identity.User.Value!=sid)continue;}}finally{CloseHandle(token);}
            string path=Path.GetFullPath(process.MainModule.FileName);
            if(IsTargetPath(baseDir,path)&&!result.Contains(path))result.Add(path);
        }catch{}
        if(result.Count==0||result.Count>4)throw new Exception("CS_DISCORD_PROCESS");return result;
    }
    internal static bool IsTargetPath(string root,string path){
        if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))return false;
        string tail=path.Substring(root.Length+1);
        return System.Text.RegularExpressions.Regex.IsMatch(tail,@"\Aapp-[0-9]+\.[0-9]+\.[0-9]+\\Discord\.exe\z",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
    public static void SelfTest(){
        string root=@"C:\Users\test\AppData\Local\Discord";
        if(!IsTargetPath(root,root+@"\app-1.0.9266\Discord.exe")||IsTargetPath(root,root+@"\app-1.0.9266\Discord.exe.other.exe")||
            IsTargetPath(root,root+@"\..\game.exe")||IsTargetPath(root,@"C:\Games\Discord.exe"))throw new Exception("Discord path policy");
    }
}
