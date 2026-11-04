#include "std_include.hpp"
#include "settings.hpp"
#include "runtime_update.hpp"
#include "fix/fix_ini.hpp"
#include <utils/io.hpp>
#include <utils/string.hpp>
#include <utils/properties.hpp>
#include <charconv>

namespace muac {
namespace {
    std::wstring display_key() {
#ifdef MUAC_SETTINGS_TEST
        return L"Software\\UltimateLegendsTests\\MUAC\\native-" + std::to_wstring(GetCurrentProcessId());
#else
#ifdef _DEBUG
        // Isolate integration tests from the owner's live game settings. Only a
        // bounded leaf under our test namespace is accepted; never an arbitrary key.
        if(const auto test=utils::properties::load("muac-test-registry-key");test && !test->empty()) {
            const bool valid=test->size()<=64 && std::all_of(test->begin(),test->end(),[](char c){
                return (c>='0'&&c<='9')||(c>='a'&&c<='f');
            });
            return L"Software\\UltimateLegendsTests\\MUAC\\"+utils::string::convert(valid?*test:std::string("invalid"));
        }
#endif
        return L"Software\\Activision\\Marvel Ultimate Alliance\\Settings\\Display";
#endif
    }
    std::string key_value(const std::filesystem::path& file, const wchar_t* section, const char* key, const char* fallback) {
        auto values=fix_ini::read(file,section,{key});
        const auto it=values.find(key);
        return it==values.end() ? fallback : it->second;
    }
    bool flag(const std::string& value, bool fallback) {
        return fix_ini::parse_flag(value).value_or(fallback?"1":"0")=="1";
    }
    struct registry_value { bool exists{}; DWORD type{}; std::vector<BYTE> data; };
    registry_value resolution_snapshot() {
        registry_value out; HKEY key{};
        if(RegOpenKeyExW(HKEY_CURRENT_USER,display_key().c_str(),0,KEY_QUERY_VALUE,&key)!=ERROR_SUCCESS) return out;
        DWORD size{};
        if(RegQueryValueExW(key,L"Resolution",nullptr,&out.type,nullptr,&size)==ERROR_SUCCESS && size<=65536) {
            out.data.resize(size);
            out.exists=RegQueryValueExW(key,L"Resolution",nullptr,&out.type,out.data.data(),&size)==ERROR_SUCCESS;
            out.data.resize(size);
        }
        RegCloseKey(key); return out;
    }
    bool set_resolution(const registry_value& value) {
        HKEY key{};
        if(RegCreateKeyExW(HKEY_CURRENT_USER,display_key().c_str(),0,nullptr,0,KEY_SET_VALUE,nullptr,&key,nullptr)!=ERROR_SUCCESS) return false;
        const auto result=value.exists ? RegSetValueExW(key,L"Resolution",0,value.type,value.data.data(),static_cast<DWORD>(value.data.size()))
                                      : RegDeleteValueW(key,L"Resolution");
        RegCloseKey(key); return result==ERROR_SUCCESS || (!value.exists && result==ERROR_FILE_NOT_FOUND);
    }
    std::string resolution() {
        const auto saved=resolution_snapshot();
        if(!saved.exists || saved.type!=REG_SZ || saved.data.size()%sizeof(wchar_t)) return "800x600";
        std::wstring text(saved.data.size()/sizeof(wchar_t),L'\0');
        std::memcpy(text.data(),saved.data.data(),saved.data.size());
        while(!text.empty() && text.back()==L'\0') text.pop_back();
        return utils::string::convert(text);
    }
    bool is_muac_fix(const std::filesystem::path& file) {
        DWORD ignored{}; const auto size=GetFileVersionInfoSizeW(file.c_str(),&ignored);
        if(!size || size>1024*1024) return false;
        std::vector<BYTE> data(size); wchar_t* description{}; UINT length{}; VS_FIXEDFILEINFO* version{};
        if(!GetFileVersionInfoW(file.c_str(),0,size,data.data()) ||
           !VerQueryValueW(data.data(),L"\\",reinterpret_cast<void**>(&version),&length) ||
           !version || length<sizeof(*version) || version->dwSignature!=0xfeef04bd) return false;
        const auto number=(static_cast<std::uint64_t>(version->dwFileVersionMS)<<32)|version->dwFileVersionLS;
        if(number<0x0000000100010000ULL) return false; // 0.1.1: process cursor guard and background option.
        if(!VerQueryValueW(data.data(),L"\\StringFileInfo\\040904b0\\FileDescription",reinterpret_cast<void**>(&description),&length) ||
           !description || !length || length>80) return false;
        std::wstring_view text(description,length);
        if(text.back()==L'\0') text.remove_suffix(1);
        return text==L"MUA Classic Fix";
    }
    bool integer(const std::string& text, int& number) {
        const auto [end,error]=std::from_chars(text.data(),text.data()+text.size(),number);
        return error==std::errc{} && end==text.data()+text.size();
    }
    bool ipv4(const std::string& text) {
        std::size_t start=0;
        for(int part=0;part<4;++part){
            const auto end=part<3?text.find('.',start):text.size();
            if(end==std::string::npos || end<=start || end-start>3) return false;
            const auto value=text.substr(start,end-start); int number{};
            if(!std::all_of(value.begin(),value.end(),[](char c){return c>='0'&&c<='9';}) ||
               !integer(value,number) || number>255) return false;
            start=end+1;
        }
        return start==text.size()+1;
    }
}

values read(const std::filesystem::path& folder) {
    const auto graphics=folder/L"dgVoodoo.conf", input=folder/L"muac-fix.ini";
    const bool full=flag(key_value(graphics,L"General","FullScreenMode","true"),true) ||
                    flag(key_value(graphics,L"DirectX","AppControlledScreenMode","true"),true);
    const auto attributes=utils::string::to_lower(key_value(graphics,L"GeneralExt","WindowedAttributes",""));
    const auto domain=utils::string::to_lower(key_value(input,L"Online","Domain","openspy.net"));
    const auto server=key_value(input,L"Online","Server","");
    return {{"Mode",full?"fullscreen":attributes.find("borderless")!=std::string::npos?"borderless":"windowed"},
        {"Resolution",resolution()},
        {"FrameLimit",key_value(graphics,L"GeneralExt","FPSLimit","0")},
        {"VSync",flag(key_value(graphics,L"DirectX","ForceVerticalSync","false"),false)?"1":"0"},
        {"Watermark",flag(key_value(graphics,L"DirectX","dgVoodooWatermark","true"),true)?"1":"0"},
        {"ControllerSupport",flag(key_value(input,L"Input","ControllerSupport","1"),true)?"1":"0"},
        {"RunInBackground",flag(key_value(input,L"Display","RunInBackground","1"),true)?"1":"0"},
        {"CaptureMouse",(flag(key_value(input,L"Input","CaptureMouse","0"),false) ||
                          flag(key_value(graphics,L"General","CaptureMouse","true"),true))?"1":"0"},
        {"OnlineService",ipv4(server)?"custom":domain=="off"?"off":domain=="openspy.net"?"openspy":"custom"}};
}

std::optional<std::string> normalise(const std::string& key, const std::string& text) {
    auto value=fix_ini::trim(text);
    if(key=="ControllerSupport"||key=="CaptureMouse"||key=="RunInBackground"||key=="Watermark"||key=="VSync") return fix_ini::parse_flag(value);
    if(key=="Mode" && (value=="windowed"||value=="borderless"||value=="fullscreen")) return value;
    if(key=="OnlineService" && (value=="openspy"||value=="off")) return value;
    int number{};
    if(key=="FrameLimit" && integer(value,number) && (number==0 || (number>=20 && number<=240))) return std::to_string(number);
    if(key=="Resolution") {
        const auto split=value.find('x'); int width{},height{};
        if(split!=std::string::npos && integer(value.substr(0,split),width) && integer(value.substr(split+1),height) &&
           width>=640 && width<=7680 && height>=480 && height<=4320)
            return std::to_string(width)+"x"+std::to_string(height);
    }
    return std::nullopt;
}

std::vector<std::string> missing_runtime(const std::filesystem::path& folder) {
    std::vector<std::string> missing;
    if(runtime::recovery_pending(folder)) missing.push_back("Interrupted MUA Classic Fix update (retry Update)");
    if(!is_muac_fix(folder/L"dinput8.dll")) missing.push_back("MUA Classic Fix 0.1.1 or newer (dinput8.dll)");
    for(const auto* file : {"version.dll","D3D9.dll","dgVoodoo.conf"})
        if(!utils::io::file_exists(folder/file)) missing.emplace_back(file);
    return missing;
}

bool write(const std::filesystem::path& folder, const values& requested, std::string& error) {
    values changes;
    for(const auto& [key,value] : requested) {
        const auto checked=normalise(key,value);
        if(!checked) {error="Invalid MUAC setting: "+key;return false;}
        changes.emplace(key,*checked);
    }
    if(changes.empty()){error="No settings were supplied.";return false;}
    struct backup {std::filesystem::path path;bool exists;std::string data;};
    std::vector<backup> backups;
    for(const auto* file : {L"dgVoodoo.conf",L"muac-fix.ini"}) {
        backup original{folder/file,false,{}};
        const auto attributes=GetFileAttributesW(original.path.c_str());
        if(attributes!=INVALID_FILE_ATTRIBUTES && (attributes&FILE_ATTRIBUTE_REPARSE_POINT)) {error="Linked settings files cannot be edited.";return false;}
        original.exists=utils::io::file_exists(original.path);
        if(original.exists && !utils::io::read_file(original.path,&original.data)){error="Could not back up settings.";return false;}
        backups.push_back(std::move(original));
    }
    const auto old_resolution=resolution_snapshot();
    const auto graphics=folder/L"dgVoodoo.conf", input=folder/L"muac-fix.ini";
    bool ok=true,registry_written=false;
    const auto put=[&](const std::filesystem::path& file,const wchar_t* section,fix_ini::changes keys){
        if(ok) ok=fix_ini::write(file,section,keys,error);
    };
    for(const auto& [key,value] : changes) {
        if(key=="Mode") {
            put(graphics,L"General",{{"FullScreenMode",value=="fullscreen"?"true":"false"}});
            put(graphics,L"DirectX",{{"AppControlledScreenMode","false"}});
            put(graphics,L"GeneralExt",{{"WindowedAttributes",value=="borderless"?"borderless,fullscreensize":""}});
            put(graphics,L"General",{{"CenterAppWindow","true"}});
        } else if(key=="FrameLimit") put(graphics,L"GeneralExt",{{"FPSLimit",value}});
        else if(key=="VSync") put(graphics,L"DirectX",{{"ForceVerticalSync",value=="1"?"true":"false"}});
        else if(key=="Watermark") put(graphics,L"DirectX",{{"dgVoodooWatermark",value=="1"?"true":"false"}});
        else if(key=="ControllerSupport") put(input,L"Input",{{key,value}});
        else if(key=="RunInBackground") put(input,L"Display",{{key,value}});
        else if(key=="CaptureMouse") {
            put(input,L"Input",{{key,value}});
            put(graphics,L"General",{{"CaptureMouse",value=="1"?"true":"false"}});
        } else if(key=="OnlineService") {
            put(input,L"Online",{{"Domain",value=="openspy"?"openspy.net":"off"},{"Server",std::nullopt}});
        }
    }
    if(ok && changes.contains("Resolution")) {
        const auto wide=utils::string::convert(changes.at("Resolution"));
        registry_value next{true,REG_SZ,std::vector<BYTE>((wide.size()+1)*sizeof(wchar_t))};
        std::memcpy(next.data.data(),wide.c_str(),next.data.size());
        ok=set_resolution(next); registry_written=ok;
        if(!ok) error="Could not save the game's resolution.";
    }
    if(ok) return true;
    bool restored=true;
    for(const auto& original : backups) {
        WritePrivateProfileStringW(nullptr,nullptr,nullptr,original.path.c_str());
        if(original.exists) restored=utils::io::write_file(original.path,original.data)&&restored;
        else {std::error_code ec;std::filesystem::remove(original.path,ec);restored=!ec&&restored;}
        WritePrivateProfileStringW(nullptr,nullptr,nullptr,original.path.c_str());
    }
    if(registry_written) restored=set_resolution(old_resolution)&&restored;
    if(!restored) error+=" Some settings could not be restored; inspect the settings files.";
    return false;
}
}
