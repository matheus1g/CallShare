// Read-only checks from the published NDISAPI contract. No SET IOCTLs are used here.
using System;
using System.Runtime.InteropServices;
internal static class DriverPreflight {
    static uint Code(int operation){return (0x8300u<<16)|((uint)(0x830+operation)<<2);}
    public static void AssertIdle(bool requireEmptyFilters=true){
        IntPtr driver=CreateFile(@"\\.\NDISRD",0,3,IntPtr.Zero,3,0,IntPtr.Zero);
        if(driver==new IntPtr(-1))throw new Exception("CS_PROCESS_DRIVER");
        IntPtr list=Marshal.AllocHGlobal(8836),mode=Marshal.AllocHGlobal(12),count=Marshal.AllocHGlobal(4);
        try{
            Marshal.Copy(new byte[8836],0,list,8836);Marshal.WriteInt32(count,0);uint returned;
            if(!DeviceIoControl(driver,Code(16),IntPtr.Zero,0,count,4,out returned,IntPtr.Zero))throw new Exception("CS_PROCESS_DRIVER");
            if(requireEmptyFilters&&Marshal.ReadInt32(count)!=0)throw new Exception("CS_PROCESS_DRIVER_BUSY");
            if(!DeviceIoControl(driver,Code(1),list,8836,list,8836,out returned,IntPtr.Zero))throw new Exception("CS_PROCESS_DRIVER");
            int adapters=Marshal.ReadInt32(list);if(adapters<1||adapters>32)throw new Exception("CS_PROCESS_DRIVER");
            for(int i=0;i<adapters;i++){
                Marshal.WriteIntPtr(mode,Marshal.ReadIntPtr(list,8196+i*8));Marshal.WriteInt32(mode,8,0);
                if(!DeviceIoControl(driver,Code(13),mode,12,mode,12,out returned,IntPtr.Zero))throw new Exception("CS_PROCESS_DRIVER");
                if(Marshal.ReadInt32(mode,8)!=0)throw new Exception("CS_PROCESS_DRIVER_BUSY");
            }
        }finally{Marshal.FreeHGlobal(list);Marshal.FreeHGlobal(mode);Marshal.FreeHGlobal(count);CloseHandle(driver);}
    }
    public static void SelfTest(){if(Code(1)!=0x830020C4||Code(13)!=0x830020F4||Code(16)!=0x83002100)throw new Exception("NDISAPI query ABI");}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool DeviceIoControl(IntPtr handle,uint code,IntPtr input,int inputSize,IntPtr output,int outputSize,out uint returned,IntPtr overlapped);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
}
