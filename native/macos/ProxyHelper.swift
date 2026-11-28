import Foundation
import SystemConfiguration
import Security
import Darwin

// One binary serves as the signed XPC client and the root launch daemon.
let serviceName = "io.gungun.proxy-helper"
@objc protocol ProxyProtocol {
    func request(_ data: Data, withReply reply: @escaping (Data) -> Void)
}
struct ProxyError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
func encode(_ value: Any) -> Data { (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"error\":\"配置序列化失败\"}".utf8) }
func same(_ a: [String: Any], _ b: [String: Any]) -> Bool { NSDictionary(dictionary: a).isEqual(to: b) }
func fail(_ message: String) throws -> Never { throw ProxyError(message) }
func preferences() throws -> SCPreferences {
    guard let prefs = SCPreferencesCreate(nil, serviceName as CFString, nil) else { try fail("无法读取系统网络配置") }
    return prefs
}
func services(_ prefs: SCPreferences) throws -> [SCNetworkService] {
    guard let all = SCNetworkServiceCopyAll(prefs) as? [SCNetworkService] else { try fail("网络服务列表读取失败") }
    return all
}
func serviceID(_ item: SCNetworkService) throws -> String {
    guard let value = SCNetworkServiceGetServiceID(item) else { try fail("网络服务缺少有效标识") }
    return value as String
}
func service(_ prefs: SCPreferences, _ id: String) throws -> SCNetworkService {
    guard let found = try services(prefs).first(where: { try serviceID($0) == id }) else { try fail("所选网络服务已不存在") }
    return found
}
func proxyProtocol(_ service: SCNetworkService) throws -> SCNetworkProtocol {
    guard let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies) else { try fail("该网络服务不支持代理配置") }
    return proto
}
func config(_ proto: SCNetworkProtocol) throws -> [String: Any] {
    // Absence is a valid empty dictionary. A PAC enabled without URL is not safe to overwrite.
    let value = SCNetworkProtocolGetConfiguration(proto) as? [String: Any] ?? [:]
    if (value[kSCPropNetProxiesProxyAutoConfigEnable as String] as? NSNumber)?.boolValue == true {
        guard let url = value[kSCPropNetProxiesProxyAutoConfigURLString as String] as? String, !url.isEmpty else { try fail("当前 PAC 已启用但 URL 无法读取，停止修改") }
    }
    return value
}
func apply(_ prefs: SCPreferences, _ proto: SCNetworkProtocol, _ value: [String: Any]) throws {
    guard SCNetworkProtocolSetConfiguration(proto, value as CFDictionary), SCPreferencesCommitChanges(prefs), SCPreferencesApplyChanges(prefs) else { try fail("系统代理提交或应用失败：\(String(cString: SCErrorString(SCError())))") }
}
func primaryService() -> String {
    guard let store = SCDynamicStoreCreate(nil, serviceName as CFString, nil, nil) else { return "" }
    for family in ["IPv4", "IPv6"] {
        if let global = SCDynamicStoreCopyValue(store, "State:/Network/Global/\(family)" as CFString) as? [String: Any], let id = global["PrimaryService"] as? String { return id }
    }
    return ""
}
struct Journal {
    var uid: uid_t
    var service: String
    var original: [String: Any]
    var applied: [String: Any]
    var port: Int
    var lease: Date
    var switchUntil: Date = .distantPast
    var conflict: Bool = false
    var error: String = ""
    var json: [String: Any] { ["uid": uid, "service": service, "original": original, "applied": applied, "port": port, "conflict": conflict, "error": error] }
}
final class Engine {
    let queue = DispatchQueue(label: serviceName)
    let root = "/var/db/io.gungun.proxy-helper"
    var journals: [uid_t: Journal] = [:]
    var recoveryError = ""
    var timer: DispatchSourceTimer?
    init() {
        do {
            try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            for name in try FileManager.default.contentsOfDirectory(atPath: root) where name.hasSuffix(".json") {
                let data = try Data(contentsOf: URL(fileURLWithPath: root + "/" + name))
                guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let uid = obj["uid"] as? UInt32, let id = obj["service"] as? String,
                      let original = obj["original"] as? [String: Any], let applied = obj["applied"] as? [String: Any], let port = obj["port"] as? Int else { try fail("恢复日志损坏：\(name)") }
                journals[uid] = Journal(uid: uid, service: id, original: original, applied: applied, port: port, lease: .distantPast, conflict: obj["conflict"] as? Bool ?? false, error: obj["error"] as? String ?? "")
            }
            for uid in Array(journals.keys) { do { try restore(uid) } catch { journals[uid]?.error = String(describing: error); try? persist(uid) } }
        } catch { recoveryError = String(describing: error) }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in self?.watchdog() }
        timer.resume(); self.timer = timer
    }
    func path(_ uid: uid_t) -> String { root + "/\(uid).json" }
    func persist(_ uid: uid_t) throws {
        guard let journal = journals[uid] else { return }
        let url = URL(fileURLWithPath: path(uid))
        let data = try JSONSerialization.data(withJSONObject: journal.json, options: [.sortedKeys])
        try data.write(to: url, options: .atomic)
        guard chmod(path(uid), 0o600) == 0 else { try fail("恢复日志权限设置失败") }
        let fd = open(path(uid), O_RDONLY); guard fd >= 0 else { try fail("恢复日志无法打开") }; defer { close(fd) }
        guard fsync(fd) == 0 else { try fail("恢复日志同步失败") }
        let dir = open(root, O_RDONLY); guard dir >= 0 else { try fail("恢复目录无法打开") }; defer { close(dir) }
        guard fsync(dir) == 0 else { try fail("恢复目录同步失败") }
    }
    func clear(_ uid: uid_t) throws { if FileManager.default.fileExists(atPath: path(uid)) { try FileManager.default.removeItem(atPath: path(uid)) }; journals.removeValue(forKey: uid) }
    func restore(_ uid: uid_t) throws {
        guard let journal = journals[uid] else { return }
        if journal.conflict { try fail("系统代理已被其他应用或用户修改；保留当前设置，请核验后解除恢复记录") }
        let prefs = try preferences()
        guard SCPreferencesLock(prefs, true) else { try fail("无法锁定系统网络配置") }
        defer { SCPreferencesUnlock(prefs) }
        SCPreferencesSynchronize(prefs)
        let proto = try proxyProtocol(service(prefs, journal.service))
        let current = try config(proto)
        if same(current, journal.original) { try clear(uid); return }
        guard same(current, journal.applied) else { journals[uid]?.conflict = true; try persist(uid); try fail("系统代理已被修改，停止自动恢复以保护当前配置") }
        try apply(prefs, proto, journal.original)
        SCPreferencesSynchronize(prefs)
        guard same(try config(try proxyProtocol(service(prefs, journal.service))), journal.original) else { try fail("系统代理恢复验证失败") }
        try clear(uid)
    }
    func watchdog() {
        for uid in Array(journals.keys) {
            guard let journal = journals[uid], !journal.conflict else { continue }
            do {
                let prefs = try preferences()
                let current = try config(try proxyProtocol(service(prefs, journal.service)))
                if !same(current, journal.applied) && !same(current, journal.original) { journals[uid]?.conflict = true; journals[uid]?.error = "代理设置已被用户或其他应用修改"; try persist(uid); continue }
                if Date().timeIntervalSince(journal.lease) > 10 || (Date() > journal.switchUntil && !listening(journal.port)) { try restore(uid) }
            } catch { journals[uid]?.error = String(describing: error); try? persist(uid) }
        }
    }
    func listening(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0); if fd < 0 { return false }; defer { close(fd) }
        var timeout = timeval(tv_sec: 0, tv_usec: 250000)
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_port = UInt16(port).bigEndian; address.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 } }
    }
    func execute(_ input: [String: Any], uid: uid_t) throws -> Any {
        guard recoveryError.isEmpty else { try fail("恢复状态不可读取：\(recoveryError)") }
        guard let action = input["action"] as? String else { try fail("缺少操作") }
        if action == "status" { return ["enabled": journals[uid] != nil && journals[uid]?.conflict == false, "conflict": journals[uid]?.conflict ?? false, "serviceId": journals[uid]?.service ?? "", "port": journals[uid]?.port ?? 0, "error": journals[uid]?.error ?? ""] as [String: Any] }
        if action == "lease" {
            guard journals[uid] != nil, journals[uid]?.conflict == false else { try fail("系统代理租约失效或设置已被修改") }
            journals[uid]?.lease = Date()
            if input["switching"] as? Bool == true { journals[uid]?.switchUntil = Date().addingTimeInterval(10) }
            return true
        }
        if action == "beginSwitch" {
            guard journals[uid] != nil, journals[uid]?.conflict == false else { try fail("代理恢复记录不可用，不能开始切换") }
            // A bounded gap is allowed for the same-port core replacement. Loss of the
            // application lease still restores within the normal lease interval.
            journals[uid]?.switchUntil = Date().addingTimeInterval(30)
            journals[uid]?.lease = Date(); return true
        }
        if action == "endSwitch" { journals[uid]?.switchUntil = .distantPast; return true }
        if action == "disable" { try restore(uid); return true }
        if action == "acknowledgeConflict" {
            guard journals[uid]?.conflict == true, input["confirm"] as? Bool == true else { try fail("请先核验网络设置并确认解除恢复记录") }
            try clear(uid); return true
        }
        let prefs = try preferences()
        if action == "services" {
            let primary = primaryService()
            return try services(prefs).filter { SCNetworkServiceGetEnabled($0) }.map { item -> [String: Any] in
                let id = try serviceID(item)
                let name: String
                if let value = SCNetworkServiceGetName(item) { name = value as String }
                else { name = id }
                return ["id": id, "name": name, "active": id == primary, "proxies": try config(try proxyProtocol(item))]
            }
        }
        guard action == "enable", let id = input["serviceId"] as? String, let port = input["port"] as? Int, (1024...65535).contains(port) else { try fail("无效的系统代理请求") }
        var consoleUID: uid_t = 0; var consoleGID: gid_t = 0
        _ = SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID)
        guard uid != 0, consoleUID == uid else { try fail("只有当前登录的桌面用户可以开启系统代理") }
        guard journals[uid] == nil else { try fail("已有系统代理恢复记录，请先关闭或处理冲突") }
        guard !journals.values.contains(where: { $0.service == id }) else { try fail("网络服务正被另一用户管理") }
        guard listening(port) else { try fail("本机核心端口未监听") }
        guard SCPreferencesLock(prefs, true) else { try fail("无法锁定系统网络配置") }
        defer { SCPreferencesUnlock(prefs) }
        SCPreferencesSynchronize(prefs)
        let proto = try proxyProtocol(service(prefs, id)); let before = try config(proto)
        var target = before
        for prefix in ["HTTP", "HTTPS", "SOCKS"] { target[prefix + "Enable"] = 1; target[prefix + "Proxy"] = "127.0.0.1"; target[prefix + "Port"] = port }
        target["ProxyAutoConfigEnable"] = 0; target["ProxyAutoDiscoveryEnable"] = 0
        journals[uid] = Journal(uid: uid, service: id, original: before, applied: target, port: port, lease: Date())
        try persist(uid) // Durable recovery BEFORE any network mutation.
        do {
            try apply(prefs, proto, target); SCPreferencesSynchronize(prefs)
            guard same(try config(try proxyProtocol(service(prefs, id))), target) else { try fail("系统代理设置验证失败") }
            return true
        } catch {
            // The preferences lock excludes other writers throughout apply and rollback.
            do {
                try apply(prefs, proto, before); SCPreferencesSynchronize(prefs)
                guard same(try config(try proxyProtocol(service(prefs, id))), before) else { try fail("回滚验证失败") }
                try clear(uid)
            } catch { journals[uid]?.error = "系统设置失败且回滚失败：\(error)"; try? persist(uid); try fail(journals[uid]?.error ?? "回滚失败") }
            throw error
        }
    }
}
final class Session: NSObject, ProxyProtocol {
    let engine: Engine; let uid: uid_t
    init(_ engine: Engine, _ uid: uid_t) { self.engine = engine; self.uid = uid }
    func request(_ data: Data, withReply reply: @escaping (Data) -> Void) {
        engine.queue.async {
            do {
                guard data.count <= 65536, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("请求格式无效") }
                reply(encode(["ok": true, "value": try self.engine.execute(input, uid: self.uid)]))
            } catch { reply(encode(["ok": false, "error": String(describing: error)])) }
        }
    }
}
final class Listener: NSObject, NSXPCListenerDelegate {
    let engine = Engine()
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // Pin both the designated requirement and the code hash of this registered helper.
        var own: SecCode?; var guest: SecCode?
        var ownStatic: SecStaticCode?; var guestStatic: SecStaticCode?
        var requirement: SecRequirement?
        // The Swift SDK separates running SecCode from on-disk SecStaticCode.
        // Validate running code, then explicitly obtain static objects for APIs
        // that inspect the designated requirement and signing metadata.
        guard SecCodeCopySelf([], &own) == errSecSuccess, let own = own,
              SecCodeCheckValidity(own, [], nil) == errSecSuccess,
              SecCodeCopyStaticCode(own, [], &ownStatic) == errSecSuccess, let ownStatic = ownStatic,
              SecCodeCopyDesignatedRequirement(ownStatic, [], &requirement) == errSecSuccess, let requirement = requirement,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: NSNumber(value: connection.processIdentifier)] as CFDictionary, [], &guest) == errSecSuccess, let guest = guest,
              SecCodeCheckValidity(guest, [], requirement) == errSecSuccess,
              SecCodeCopyStaticCode(guest, [], &guestStatic) == errSecSuccess, let guestStatic = guestStatic,
              SecStaticCodeCheckValidity(ownStatic, [], requirement) == errSecSuccess,
              SecStaticCodeCheckValidity(guestStatic, [], requirement) == errSecSuccess else { return false }
        var info: CFDictionary?; var guestInfo: CFDictionary?
        guard SecCodeCopySigningInformation(ownStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              SecCodeCopySigningInformation(guestStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &guestInfo) == errSecSuccess,
              let ownHash = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data,
              let guestHash = (guestInfo as? [String: Any])?[kSecCodeInfoUnique as String] as? Data,
              ownHash == guestHash else { return false }
        connection.exportedInterface = NSXPCInterface(with: ProxyProtocol.self)
        connection.exportedObject = Session(engine, connection.effectiveUserIdentifier)
        connection.resume(); return true
    }
}
@available(macOS 13.0, *) func bridge() {
    let mode = CommandLine.arguments.dropFirst().first ?? "request"
    do {
        if mode == "register" || mode == "authorization" {
            try fail("请在 Gungun.app 设置中授权；SMAppService 必须由应用主进程调用")
        }
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard input.count <= 65536 else { try fail("请求过大") }
        let connection = NSXPCConnection(machServiceName: serviceName, options: .privileged)
        connection.remoteObjectInterface = NSXPCInterface(with: ProxyProtocol.self)
        let semaphore = DispatchSemaphore(value: 0)
        var result = encode(["ok": false, "error": "特权辅助程序不可用，请在设置中授权"])
        connection.interruptionHandler = { semaphore.signal() }
        connection.invalidationHandler = { semaphore.signal() }
        connection.resume()
        let remote = connection.remoteObjectProxyWithErrorHandler { _ in semaphore.signal() } as? ProxyProtocol
        remote?.request(input) { data in result = data; semaphore.signal() }
        _ = semaphore.wait(timeout: .now() + 15)
        connection.invalidate()
        print(String(data: result, encoding: .utf8)!)
    } catch { print(String(data: encode(["ok": false, "error": String(describing: error)]), encoding: .utf8)!) }
}
if CommandLine.arguments.contains("daemon") {
    guard geteuid() == 0 else { exit(1) }
    let delegate = Listener(); let listener = NSXPCListener(machServiceName: serviceName); listener.delegate = delegate; listener.resume(); RunLoop.current.run()
} else if #available(macOS 13.0, *) { bridge() }
else { print("{\"ok\":false,\"error\":\"需要 macOS 13 或更高版本\"}") }
