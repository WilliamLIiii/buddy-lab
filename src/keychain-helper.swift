import Foundation
import Security
import LocalAuthentication

// The credential travels through stdin/stdout, never the process argument list.
let input = FileHandle.standardInput.readDataToEndOfFile()
func reply(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
}
guard let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: String],
      let operation = request["operation"], let service = request["service"], let account = request["account"] else {
    reply(["ok": false, "status": -50]); exit(1)
}
let authenticationContext = LAContext()
authenticationContext.interactionNotAllowed = true
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: service,
                            kSecAttrAccount as String: account,
                            kSecUseAuthenticationContext as String: authenticationContext]
switch operation {
case "get":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { reply(["ok": true]) }
    else if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) { reply(["ok": true, "value": value]) }
    else { reply(["ok": false, "status": Int(status)]) }
case "set":
    guard let value = request["value"] else { reply(["ok": false, "status": -50]); exit(1) }
    let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        status = SecItemAdd(item as CFDictionary, nil)
    }
    reply(["ok": status == errSecSuccess, "status": Int(status)])
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    reply(["ok": status == errSecSuccess || status == errSecItemNotFound, "status": Int(status)])
default:
    reply(["ok": false, "status": -50])
}
