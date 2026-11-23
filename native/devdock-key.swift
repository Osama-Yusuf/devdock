// devdock-key: DevDock's action key, kept in the Secure Enclave.
// The private key never leaves the chip; the file only holds a blob this Mac's
// Secure Enclave can use. Every signature needs Touch ID (or the login password).
//
//   devdock-key pubkey <keyfile>          creates the key if missing, prints its public key (base64 SPKI)
//   devdock-key sign <keyfile> <reason>   signs stdin, prints base64 DER ECDSA P-256/SHA-256
//   devdock-key unlock <reason>           Touch ID (or the login password) to open DevDock; exit 0 = you
//
// Build: swiftc -O native/devdock-key.swift -o native/devdock-key
import CryptoKit
import Foundation
import LocalAuthentication

func fail(_ msg: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
if args.count == 3 && args[1] == "unlock" {
  let done = DispatchSemaphore(value: 0)
  var ok = false
  LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args[2]) { r, _ in ok = r; done.signal() }
  done.wait()
  exit(ok ? 0 : 2)
}
guard args.count >= 3 else { fail("usage: devdock-key pubkey|sign <keyfile> [reason]") }
guard SecureEnclave.isAvailable else { fail("This Mac has no Secure Enclave", 3) }
let file = URL(fileURLWithPath: args[2])

func load(_ ctx: LAContext? = nil) throws -> SecureEnclave.P256.Signing.PrivateKey {
  if let blob = try? Data(contentsOf: file) {
    return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
  }
  var err: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                     [.privateKeyUsage, .userPresence], &err) else { fail("access control: \(String(describing: err))") }
  let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
  try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
  try key.dataRepresentation.write(to: file, options: .atomic)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  return key
}

do {
  switch args[1] {
  case "pubkey":
    print(try load().publicKey.derRepresentation.base64EncodedString())
  case "sign":
    let ctx = LAContext()
    ctx.localizedReason = args.count > 3 ? args[3] : "confirm this action"
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { fail("nothing to sign") }
    print(try load(ctx).signature(for: data).derRepresentation.base64EncodedString())
  default:
    fail("unknown command \(args[1])")
  }
} catch let e as LAError where e.code == .userCancel || e.code == .appCancel || e.code == .systemCancel {
  fail("cancelled", 2)
} catch {
  // CryptoKit wraps the Touch ID cancel in its own error
  fail("\(error)", "\(error)".contains("-128") || "\(error)".contains("cancel") ? 2 : 1)
}
