// Muse Bridge Bluetooth helper: advertises a Muse Gadget setup service with CoreBluetooth and relays raw GATT
// traffic as JSON lines. All pairing logic lives in TypeScript (muse/pairing.ts); this only moves bytes.
//
//   musebridge-ble <local name>
//   stdout: {"ev":"state","state":"poweredOn"} {"ev":"advertising"} {"ev":"subscribed","mtu":N}
//           {"ev":"unsubscribed"} {"ev":"write","data":"<base64>"} {"ev":"error","message":"..."}
//   stdin:  {"op":"notify","data":"<base64>"}   (EOF stops advertising and exits)
//
// A legacy advertisement holds 31 bytes and macOS gives apps no scan response, so it carries the name and the
// firmware's "not set up" manufacturer flag but not the 128-bit service UUID; the Muse app matches the name.
import CoreBluetooth
import Foundation

let serviceUUID = CBUUID(string: "7fdd3d1c-38ea-46cf-8b46-314ecf5f240c")
let rxUUID = CBUUID(string: "4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01")
let txUUID = CBUUID(string: "d75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c")

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

final class Peripheral: NSObject, CBPeripheralManagerDelegate {
    let name: String
    let queue = DispatchQueue(label: "musebridge.ble")
    var manager: CBPeripheralManager!
    var tx: CBMutableCharacteristic!
    var pending: [Data] = []
    var lastValue = Data()

    init(name: String) {
        self.name = name
        super.init()
        manager = CBPeripheralManager(delegate: self, queue: queue)
    }

    func peripheralManagerDidUpdateState(_ pm: CBPeripheralManager) {
        let names: [CBManagerState: String] = [.unknown: "unknown", .resetting: "resetting", .unsupported: "unsupported",
                                               .unauthorized: "unauthorized", .poweredOff: "poweredOff", .poweredOn: "poweredOn"]
        emit(["ev": "state", "state": names[pm.state] ?? "unknown"])
        guard pm.state == .poweredOn else { return }
        let rx = CBMutableCharacteristic(type: rxUUID, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
        tx = CBMutableCharacteristic(type: txUUID, properties: [.read, .notify], value: nil, permissions: [.readable])
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [rx, tx]
        pm.removeAllServices()
        pm.add(service)
    }

    func peripheralManager(_ pm: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error { return emit(["ev": "error", "message": "adding the service failed: \(error.localizedDescription)"]) }
        pm.startAdvertising([
            CBAdvertisementDataLocalNameKey: name,
            CBAdvertisementDataManufacturerDataKey: Data([0xFF, 0xFF, 0x00]),
        ])
    }

    func peripheralManagerDidStartAdvertising(_ pm: CBPeripheralManager, error: Error?) {
        if let error = error { emit(["ev": "error", "message": "advertising failed: \(error.localizedDescription)"]) }
        else { emit(["ev": "advertising"]) }
    }

    func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didSubscribeTo c: CBCharacteristic) {
        emit(["ev": "subscribed", "mtu": central.maximumUpdateValueLength + 3])
    }

    func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom c: CBCharacteristic) {
        pending.removeAll()
        emit(["ev": "unsubscribed"])
    }

    func peripheralManager(_ pm: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for r in requests { if let v = r.value { emit(["ev": "write", "data": v.base64EncodedString()]) } }
        if let first = requests.first { pm.respond(to: first, withResult: .success) }
    }

    func peripheralManager(_ pm: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.offset <= lastValue.count else { return pm.respond(to: request, withResult: .invalidOffset) }
        request.value = lastValue.subdata(in: request.offset..<lastValue.count)
        pm.respond(to: request, withResult: .success)
    }

    func peripheralManagerIsReady(toUpdateSubscribers pm: CBPeripheralManager) { flush() }

    func notify(_ data: Data) {
        queue.async { self.pending.append(data); self.flush() }
    }

    func flush() {
        while let next = pending.first, tx != nil {
            lastValue = next
            if !manager.updateValue(next, for: tx, onSubscribedCentrals: nil) { return } // resumes when ready
            pending.removeFirst()
        }
    }

    func stop() {
        queue.sync { manager.stopAdvertising(); manager.removeAllServices() }
    }
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: musebridge-ble <local name>\n".data(using: .utf8)!)
    exit(2)
}
let peripheral = Peripheral(name: CommandLine.arguments[1])

DispatchQueue.global().async {
    while let line = readLine() {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              obj["op"] as? String == "notify", let b64 = obj["data"] as? String, let data = Data(base64Encoded: b64) else { continue }
        peripheral.notify(data)
    }
    peripheral.stop()
    exit(0)
}
signal(SIGTERM) { _ in exit(0) }
dispatchMain()
