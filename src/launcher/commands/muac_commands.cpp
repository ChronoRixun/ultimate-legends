#include "std_include.hpp"
#include "muac_commands.hpp"
#include "cef/cef_ui.hpp"
#include "muac/settings.hpp"
#include "muac/runtime_update.hpp"
#include "muac/setup.hpp"
#include "display/xml2_display.hpp"
#include "updater/folder_work.hpp"
#include <utils/string.hpp>

namespace commands::muac_commands {
namespace {
    rapidjson::Value text(const std::string& s,rapidjson::Document::AllocatorType& a){return rapidjson::Value(s.c_str(),static_cast<rapidjson::SizeType>(s.size()),a);}
    void failure(rapidjson::Document& out,const std::string& error){out.SetObject();out.AddMember("success",false,out.GetAllocator());out.AddMember("error",text(error,out.GetAllocator()),out.GetAllocator());}
    void state(rapidjson::Document& out){
        out.SetObject();auto& a=out.GetAllocator();const auto config=game_config::get_game_config("muac");
        const auto folder=config?config->get_install_path():std::nullopt;
        const bool installed=folder && game_config::validate_game_path("muac",*folder);
        const bool wine=muac::platform::is_wine();
        out.AddMember("wine",wine,a);
        out.AddMember("dgvoodooPresent",installed && muac::runtime::needs_wine_migration(*folder,wine),a);
        out.AddMember("installed",installed,a);out.AddMember("running",installed && game_config::is_game_process_running("muac"),a);
        out.AddMember("recoveryPending", installed && muac::runtime::recovery_pending(*folder), a);
        rapidjson::Value missing(rapidjson::kArrayType), values(rapidjson::kObjectType);
        if(installed){
            for(const auto& name:muac::missing_runtime(*folder)) missing.PushBack(text(name,a),a);
            for(const auto& [key,value]:muac::read(*folder)) values.AddMember(text(key,a),text(value,a),a);
        }
        out.AddMember("runtimeReady",installed && missing.Empty(),a);out.AddMember("missing",missing,a);out.AddMember("values",values,a);
        rapidjson::Value modes(rapidjson::kArrayType);
        for(const auto& mode:xml2_display::display_modes()){
            const auto value=std::to_string(mode.width)+"x"+std::to_string(mode.height);
            if(muac::normalise("Resolution",value)) modes.PushBack(text(value,a),a);
        }
        out.AddMember("modes",modes,a);
    }
}
void register_commands(cef::cef_ui& ui,command_context&){
    ui.add_command("start-muac-update",[](const rapidjson::Value&,rapidjson::Document& out){
        std::string error;
        if(!muac_setup::start_update(error)){failure(out,error);return;}
        out.SetObject();out.AddMember("success",true,out.GetAllocator());
    });
    ui.add_command("get-muac-setup",[](const rapidjson::Value&,rapidjson::Document& out){muac_setup::state(out);});
    ui.add_command("cancel-muac-setup",[](const rapidjson::Value&,rapidjson::Document& out){muac_setup::cancel();muac_setup::state(out);});
    ui.add_command("start-muac-setup",[](const rapidjson::Value& request,rapidjson::Document& out){
        if(!request.IsObject() || !request.HasMember("source") || !request["source"].IsString() ||
           !request.HasMember("output") || !request["output"].IsString()){failure(out,"Choose the disc source and output folder.");return;}
        const std::string source(request["source"].GetString(),request["source"].GetStringLength());
        const std::string output(request["output"].GetString(),request["output"].GetStringLength());
        if(source.find('\0')!=std::string::npos || output.find('\0')!=std::string::npos){failure(out,"Invalid path.");return;}
        std::string error;
        if(!muac_setup::start(utils::string::utf8_to_path(source),utils::string::utf8_to_path(output),error)){failure(out,error);return;}
        out.SetObject();out.AddMember("success",true,out.GetAllocator());
    });
    ui.add_command("get-muac-settings",[](const rapidjson::Value&,rapidjson::Document& out){state(out);});
    ui.add_command("set-muac-settings",[](const rapidjson::Value& request,rapidjson::Document& out){
        if(!request.IsObject() || !request.HasMember("values") || !request["values"].IsObject()){failure(out,"Expected MUAC settings.");return;}
        muac::values changes;
        for(auto it=request["values"].MemberBegin();it!=request["values"].MemberEnd();++it){
            std::string value;
            if(it->value.IsString()) value.assign(it->value.GetString(),it->value.GetStringLength());
            else if(it->value.IsBool()) value=it->value.GetBool()?"1":"0";
            else if(it->value.IsInt()) value=std::to_string(it->value.GetInt());
            else {failure(out,"Unsupported setting value.");return;}
            const std::string key(it->name.GetString(),it->name.GetStringLength());
            if(changes.contains(key) || !muac::normalise(key,value)){failure(out,"Invalid MUAC setting: "+key);return;}
            changes.emplace(key,value);
        }
        const auto config=game_config::get_game_config("muac");
        const auto folder=config?config->get_install_path():std::nullopt;
        if(!folder || !game_config::validate_game_path("muac",*folder)){failure(out,"Set up MUA 2006 first.");return;}
        if(muac::runtime::recovery_pending(*folder)){failure(out,muac::runtime::pending_message);return;}
        if(!muac::missing_runtime(*folder).empty()){failure(out,"Install the MUA 2006 runtime components first.");return;}
        // An exclusive folder hold prevents a simultaneous launch, patch or builder operation.
        const auto hold=updater::reserve(*folder,updater::folder_use::builder);
        if(!hold){failure(out,"The game folder is busy. Wait for setup or update to finish.");return;}
        if(game_config::is_game_process_running("muac")){failure(out,"Close MUA 2006 before changing these options.");return;}
        std::string error;
        if(!muac::write(*folder,changes,error)){failure(out,error);return;}
        state(out);out.AddMember("success",true,out.GetAllocator());
    });
}
}
