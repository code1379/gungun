#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <node_api.h>

// Loaded only by the Electron main process. SMAppService resolves daemon plists
// relative to the calling app's main bundle, not a standalone XPC client binary.
static napi_value fail(napi_env env, NSString *message) {
    napi_throw_error(env, nullptr, message.UTF8String);
    return nullptr;
}

static NSString *statusName(SMAppServiceStatus status) {
    switch (status) {
        case SMAppServiceStatusNotRegistered: return @"notRegistered";
        case SMAppServiceStatusEnabled: return @"enabled";
        case SMAppServiceStatusRequiresApproval: return @"requiresApproval";
        case SMAppServiceStatusNotFound: return @"notFound";
        default: return @"unknown";
    }
}

static napi_value registerService(napi_env env, napi_callback_info) {
    @autoreleasepool {
        @try {
            NSBundle *bundle = NSBundle.mainBundle;
            if (![bundle.bundleIdentifier isEqualToString:@"io.gungun.desktop"])
                return fail(env, [NSString stringWithFormat:@"辅助程序注册必须由 Gungun.app 主进程执行；当前 Bundle：%@（%@）", bundle.bundleIdentifier ?: @"unknown", bundle.bundlePath]);
            NSString *plistPath = [bundle.bundlePath stringByAppendingPathComponent:@"Contents/Library/LaunchDaemons/io.gungun.proxy-helper.plist"];
            NSFileManager *files = NSFileManager.defaultManager;
            if (![files fileExistsAtPath:plistPath])
                return fail(env, [@"应用内缺少 LaunchDaemon 文件：" stringByAppendingString:plistPath]);
            NSError *error = nil;
            NSData *data = [NSData dataWithContentsOfFile:plistPath options:0 error:&error];
            id plist = data ? [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:nullptr error:&error] : nil;
            if (![plist isKindOfClass:NSDictionary.class] ||
                ![plist[@"Label"] isEqual:@"io.gungun.proxy-helper"] ||
                ![plist[@"BundleProgram"] isEqual:@"Contents/MacOS/gungun-proxy-helper"])
                return fail(env, [NSString stringWithFormat:@"应用内 LaunchDaemon 配置无效：%@；%@", plistPath, error.localizedDescription ?: @"Label / BundleProgram 不匹配"]);
            NSString *helper = [bundle.bundlePath stringByAppendingPathComponent:plist[@"BundleProgram"]];
            if (![files isExecutableFileAtPath:helper])
                return fail(env, [@"应用内缺少可执行的系统代理辅助程序：" stringByAppendingString:helper]);

            SMAppService *service = [SMAppService daemonServiceWithPlistName:@"io.gungun.proxy-helper.plist"];
            // notFound describes service lookup, not necessarily a missing plist.
            // After verifying bundle files, attempt registration and keep NSError.
            if (service.status != SMAppServiceStatusEnabled && service.status != SMAppServiceStatusRequiresApproval) {
                error = nil;
                BOOL registered = [service registerAndReturnError:&error];
                if (!registered && service.status != SMAppServiceStatusRequiresApproval && service.status != SMAppServiceStatusEnabled)
                    return fail(env, [NSString stringWithFormat:@"系统代理辅助程序注册失败：%@ (%@:%ld)；状态：%@；Bundle：%@", error.localizedDescription ?: @"系统未提供错误说明", error.domain ?: @"unknown", (long)error.code, statusName(service.status), bundle.bundlePath]);
            }
            SMAppServiceStatus status = service.status;
            if (status == SMAppServiceStatusRequiresApproval)
                [SMAppService openSystemSettingsLoginItems];
            if (status != SMAppServiceStatusEnabled && status != SMAppServiceStatusRequiresApproval)
                return fail(env, [NSString stringWithFormat:@"辅助程序尚未注册成功：%@；Bundle：%@", statusName(status), bundle.bundlePath]);

            NSDictionary *reply = @{@"status": statusName(status), @"bundlePath": bundle.bundlePath, @"plistPath": plistPath};
            NSData *encoded = [NSJSONSerialization dataWithJSONObject:reply options:0 error:&error];
            if (!encoded) return fail(env, error.localizedDescription);
            napi_value result;
            if (napi_create_string_utf8(env, static_cast<const char *>(encoded.bytes), encoded.length, &result) != napi_ok)
                return fail(env, @"无法编码辅助程序授权响应");
            return result;
        } @catch (NSException *exception) {
            return fail(env, [NSString stringWithFormat:@"辅助程序注册异常：%@", exception.reason]);
        }
    }
}

static napi_value init(napi_env env, napi_value exports) {
    napi_value method;
    if (napi_create_function(env, "registerService", NAPI_AUTO_LENGTH, registerService, nullptr, &method) != napi_ok ||
        napi_set_named_property(env, exports, "registerService", method) != napi_ok)
        return fail(env, @"无法初始化系统代理注册模块");
    return exports;
}
NAPI_MODULE(gungun_service_registration, init)
