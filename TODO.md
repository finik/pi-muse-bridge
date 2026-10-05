# TODO

## Pairing on Linux

Pairing (`/login`) works only on macOS today. Everything after pairing is plain TypeScript and already runs on
Linux; only the Bluetooth part is platform specific. This section is a brief for whoever implements it.

### Where things stand

- `muse/pairing.ts` holds the whole pairing protocol and is platform neutral. It drives the radio through a
  small native helper process and talks to it with JSON lines:
  - helper stdout: `{"ev":"state","state":"poweredOn"|"poweredOff"|"unauthorized"|"unsupported"|"unknown"}`,
    `{"ev":"advertising"}`, `{"ev":"subscribed","mtu":N}`, `{"ev":"unsubscribed"}`,
    `{"ev":"write","data":"<base64>"}`, `{"ev":"error","message":"..."}`
  - helper stdin: `{"op":"notify","data":"<base64>"}`; EOF means stop advertising, clean up and exit.
- `muse/ble-helper.swift` is the macOS helper (CoreBluetooth). `ensureHelper()` in `muse/pairing.ts` compiles it
  and currently throws on any other platform. `BleHelper` spawns the helper and maps its events.

### What to build

1. **`muse/ble-helper-linux.py`**, a BlueZ peripheral speaking the same JSON-lines protocol. Model it on the
   Gadget SDK's `linux/src/musegadget/ble_server.py` (Apache 2.0; carry its copyright line if code is copied):
   - D-Bus via `python3-dbus` and `python3-gi` (GLib main loop). Find the adapter with `GetManagedObjects`.
   - GATT application (`GattManager1.RegisterApplication`): service `7fdd3d1c-38ea-46cf-8b46-314ecf5f240c`, RX
     `4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01` (`write`, `write-without-response`), TX
     `d75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c` (`read`, `notify`).
   - Advertisement (`LEAdvertisingManager1.RegisterAdvertisement`): `Type` peripheral, `LocalName` = the name
     passed as the only argument, `ServiceUUIDs` = the service, `ManufacturerData` `{0xFFFF: [0x00]}` (the
     "not set up" flag). Also set the adapter `Alias` to the name and `Pairable` false, and restore both on exit.
   - Events: `StartNotify` → `subscribed` (MTU: the `mtu` option of `WriteValue` when BlueZ provides it, else
     assume 163); `StopNotify` or the device's `Connected` turning false → `unsubscribed`; `WriteValue` on RX →
     `write`; registration failures → `error`; adapter `Powered` false → `state: poweredOff` (try powering it on
     first).
   - Notifications: send each packet as a `PropertiesChanged` on TX, paced about 50 ms apart (the SDK's
     `CHUNK_STAGGER_S`).
   - Read stdin with a GLib IO watch; on EOF or SIGTERM unregister the advertisement and application, restore
     the adapter, exit.
   - Keep it Python 3.7 compatible (Raspberry Pi OS buster ships 3.7): no `X | Y` type unions, no walrus.
2. **`ensureHelper()`**: on Linux, return a launcher for `python3 muse/ble-helper-linux.py` instead of compiling.
   Check up front and fail with a clear, actionable message when something is missing: `python3`, the `dbus` and
   `gi` modules (`sudo apt install bluez python3-dbus python3-gi`), a running `bluetoothd`, an adapter.
3. **Permissions**: BlueZ's D-Bus policy lets only root, members of the `bluetooth` group, and users logged in
   at the machine's own screen (`at_console`) use it. Over SSH an ordinary user gets `AccessDenied`. Map that
   error to: "add yourself to the bluetooth group: `sudo usermod -aG bluetooth $USER`, log out and in, then run
   /login again". Do not run the helper as root.
4. **Tests**: `test/run.mjs` already runs the full pairing exchange against an independent phone implementation.
   Add a scenario that drives `pairOverBluetooth` through a fake helper process (a small script speaking the
   JSON-lines protocol) so the helper contract is tested on every platform.
5. **README**: list Linux under Requirements (BlueZ, `python3-dbus`, `python3-gi`, the `bluetooth` group), add
   the Linux steps and errors to Troubleshooting, and update the layout table.

### Testing on real hardware

- Any Linux machine with Bluetooth LE works; a Raspberry Pi 3 or newer is enough. Node.js 22.18 or newer is
  needed (official builds exist for 32-bit ARM; installing into the user's home avoids touching the system).
- Run Pi's `/login` → **Sign in with an account** → **Muse Bridge** on that machine, paste a Gadget SDK token,
  and add the device from the Muse app (**Settings → Devices → Developer mode → Add Device**). It pairs as its
  own device, "Muse Bridge (hostname)", separate from any other computer's pairing.
- Then send one `muse/muse-chat` message to confirm the link works end to end.

### Out of scope here

Machines without Bluetooth (servers, cloud VMs) would need pairing done on a nearby computer and the pairing
moved over afterwards. That is a separate feature.
