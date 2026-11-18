// NDISAPI ABI from pinned Common.h: ADAPTER_MODE pack(1), x64 HANDLE+uint.
// Keep SDK listeners alive; toggle only the modes captured from our own SDK.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
internal interface IAdapterModes : IDisposable {
    Dictionary<long,uint> Read();
    void Write(long adapter,uint mode);
}
internal sealed class PacketModeGate : IDisposable {
    readonly IAdapterModes io;
    readonly Dictionary<long,uint> active;
    public bool Paused {get;private set;}
    public int ActiveAdapters {get;private set;}
    public PacketModeGate(IAdapterModes control){
        io=control;
        try{
            active=io.Read();
            foreach(var mode in active.Values){
                if(mode!=0){if((mode&3)==0||(mode&~0x3fu)!=0)throw new Exception("CS_PROCESS_ROUTER");ActiveAdapters++;}
            }
            if(ActiveAdapters==0)throw new Exception("CS_PROCESS_ROUTER");
        }catch{io.Dispose();throw;}
    }
    bool Matches(Dictionary<long,uint> actual,bool paused){
        if(actual.Count!=active.Count)return false;
        foreach(var row in active){uint mode;if(!actual.TryGetValue(row.Key,out mode)||mode!=(paused?0:row.Value))return false;}
        return true;
    }
    public void SetPaused(bool value){
        if(value==Paused){if(!Matches(io.Read(),value))throw new Exception("CS_PROCESS_ROUTER");return;}
        // Never overwrite another owner's modes or guess after a topology change.
        if(!Matches(io.Read(),Paused))throw new Exception("CS_PROCESS_ROUTER");
        foreach(var row in active)if(row.Value!=0)io.Write(row.Key,value?0:row.Value);
        if(!Matches(io.Read(),value))throw new Exception(value?"CS_PROCESS_CLEANUP":"CS_PROCESS_ROUTER");
        Paused=value;
    }
    public void Dispose(){io.Dispose();}
    internal sealed class FakeModes : IAdapterModes {
        internal Dictionary<long,uint> Modes=new Dictionary<long,uint>{{11,3},{22,0}};
        internal bool RefuseWrites;
        public Dictionary<long,uint> Read(){return new Dictionary<long,uint>(Modes);}
        public void Write(long adapter,uint mode){if(!RefuseWrites)Modes[adapter]=mode;}
        public void Dispose(){}
    }
    public static void SelfTest(){
        if(NativeAdapterModes.Code(5)!=0x830020d4u||NativeAdapterModes.Code(13)!=0x830020f4u)throw new Exception("Mode IOCTL ABI");
        var fake=new FakeModes();using(var gate=new PacketModeGate(fake)){
            for(int i=0;i<5;i++){gate.SetPaused(true);if(fake.Modes[11]!=0)throw new Exception("Pause gate");gate.SetPaused(false);if(fake.Modes[11]!=3)throw new Exception("Resume gate");}
            gate.SetPaused(true);fake.Modes[33]=0;bool refused=false;try{gate.SetPaused(false);}catch{refused=true;}if(!refused)throw new Exception("Topology changed silently");
        }
        var broken=new FakeModes();using(var gate=new PacketModeGate(broken)){
            broken.RefuseWrites=true;bool refused=false;try{gate.SetPaused(true);}catch{refused=true;}if(!refused||gate.Paused)throw new Exception("Unconfirmed standby accepted");
        }
    }
}
internal sealed class NativeAdapterModes : IAdapterModes {
    IntPtr driver;
    internal static uint Code(int operation){return (0x8300u<<16)|((uint)(0x830+operation)<<2);}
    public NativeAdapterModes(){driver=CreateFile(@"\\.\NDISRD",0,3,IntPtr.Zero,3,0,IntPtr.Zero);if(driver==new IntPtr(-1))throw new Exception("CS_PROCESS_DRIVER");}
    public Dictionary<long,uint> Read(){
        var list=new byte[8836];uint returned;
        if(!DeviceIoControl(driver,Code(1),list,list.Length,list,list.Length,out returned,IntPtr.Zero))throw new Exception("CS_PROCESS_DRIVER");
        int count=BitConverter.ToInt32(list,0);if(count<1||count>32)throw new Exception("CS_PROCESS_DRIVER");
        var result=new Dictionary<long,uint>();
        for(int i=0;i<count;i++){
            long handle=BitConverter.ToInt64(list,8196+i*8);if(handle==0||result.ContainsKey(handle))throw new Exception("CS_PROCESS_DRIVER");
            var mode=new byte[12];Array.Copy(BitConverter.GetBytes(handle),mode,8);
            if(!DeviceIoControl(driver,Code(13),mode,12,mode,12,out returned,IntPtr.Zero))throw new Exception("CS_PROCESS_DRIVER");
            result.Add(handle,BitConverter.ToUInt32(mode,8));
        }
        return result;
    }
    public void Write(long adapter,uint value){
        var mode=new byte[12];Array.Copy(BitConverter.GetBytes(adapter),mode,8);Array.Copy(BitConverter.GetBytes(value),0,mode,8,4);uint returned;
        if(!DeviceIoControl(driver,Code(5),mode,12,null,0,out returned,IntPtr.Zero))throw new Exception("CS_PROCESS_ROUTER");
    }
    public void Dispose(){if(driver!=IntPtr.Zero&&driver!=new IntPtr(-1)){CloseHandle(driver);driver=IntPtr.Zero;}}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool DeviceIoControl(IntPtr handle,uint code,byte[] input,int inputSize,byte[] output,int outputSize,out uint returned,IntPtr overlapped);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
}
