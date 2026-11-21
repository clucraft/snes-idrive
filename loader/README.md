# SNES game loader

A small service for the head unit that does three things for the [SNES app](../README.md) which an app cannot do itself: it takes **games from a phone** (*Add games from a phone* in the app shows a QR code, the phone opens the page behind it and picks `.sfc` and `.smc` files), it reads a **USB gamepad**, and it plays a **game's sound**.

It is optional. Without it the app starts and shows its games, which then come from a USB stick or over SSH; but an SNES game wants a gamepad, so in practice the app wants the loader.

> **Not on a car yet.** This is the [NES game loader](https://github.com/clucraft/nes-idrive/tree/mgu-store/loader) (its version 0.3.0) under names of its own, with what an SNES changes. That loader has run on one car (2026-11-19 and 20): there the MGU Store installed it, the NES app reached it, an Xbox One S pad on a cable worked as the gamepad, a game sent from a phone was saved and played, and a game's sound was heard on the speakers. None of that has been shown for this one. What is new here and has only run on a PC: the names, the port, what counts as a game, the stick clicks and the Xbox button passed on to the app, and sound that arrives at 32040 samples a second.

**Beside the NES game loader.** Everything of this loader has its own name, so both can be installed at once and neither touches the other: the socket `/run/clucraft-snes-loader.sock`, the units `clucraft-snes-loader.socket` and `.service`, the folder `/var/opt/clucraft-snes-loader`, the port 8494 (the NES loader's is 8493), the firewall rules' comment `clucraft-snes-loader`, and the two programs `snes-usbpipe` and `snes-sound`. It looks for the app `clucraft_snes` and opens its socket to that app alone.

## Using it

1. In the MGU Store, from the source `clucraft/snes-idrive`: install **SNES** first, then **SNES game loader**.
2. **Restart the head unit once** (the Store's Settings → Restart head unit). The loader's socket is made at a start, and the head unit only then knows the loader as something that may stop without the unit restarting.
3. In the SNES app: **Add games from a phone**. With the phone on the same Wi-Fi as the car, scan the code and pick the files. That is the Wi-Fi the car has joined, such as your home Wi-Fi or the phone's own hotspot; or the car's own Wi-Fi, which a phone is on for wireless CarPlay or through the car's hotspot.
4. **BACK** closes the page. The games are in the app's list.

The page can also take a game out again. It works while the screen with the code is up, for 15 minutes after the last game at most.

## What runs, and as whom

| | runs as | does |
|---|---|---|
| `service.js` | root | answers the SNES app on `/run/clucraft-snes-loader.sock`; puts the page's port into the firewall and takes it out; starts the page; starts `snes-usbpipe` and tells the app the gamepad's buttons; starts `snes-sound` and hands it the game's sound |
| `page.js` | the SNES app's own user | listens on the car Wi-Fi; checks and writes the games |
| `snes-usbpipe` | the SNES app's own user, in the group of the head unit's USB devices | passes a gamepad's USB packets on, while the app's drawn screen shows |
| `snes-sound` | `nobody`, in the group of the head unit's sound devices | plays a game's sound into the head unit's sound mixer, while the game runs |

- **Started by the app, never at boot.** systemd starts the service when the SNES app connects to the socket. Two minutes after the app is gone it ends. Nothing of it runs while the app's screen was never opened.
- **Only the SNES app can ask.** The socket belongs to the SNES app's own group (`sockgroup.js`), not to the group every app is in.
- **The port is open only while the screen is up.** One rule per chain, for the Wi-Fi's interfaces and port 8494 only, each with the comment `clucraft-snes-loader`. They go when the app leaves the screen, when the time runs out, when the service stops for any reason (`ExecStopPost`), and when the loader is removed.
- **Which Wi-Fi:** the car's own (`wlan_bridge`, where a phone is for wireless CarPlay or on the car's hotspot), and a Wi-Fi the car has joined (`wlan0`, `wlan1`: a home network, a phone's hotspot) when the app asks for it. The app asks while its setting *Add games over the Wi-Fi the car is on* is on, as it is at first; the code on the screen is then for that Wi-Fi. On a joined Wi-Fi the head unit is a guest: whoever else is on that network can reach the port while the screen is up, though not the page without its address. Switch the setting off for a network you do not trust; the page is then on the car's own Wi-Fi alone. The car's other networks are never opened.
- **The address is the key.** The page is at `http://<car Wi-Fi address>:8494/<20 random characters>/`, new each time. Without those characters every request is "not found"; after 100 such requests the page closes. It is plain HTTP, so anyone already on that Wi-Fi who sees the code can use it for as long as it is up.
- **The page is not root.** It runs as the user the SNES app runs as, so it can write where the app can and nowhere else. That user is the number in the name of the app's folder (`oap_<number>`); the folder's owner is whoever installed the app, the MGU Store's user on a car. The page is started inside the app's data folder, because the app's user alone does not get there: the way leads through a folder that opens only to a group the head unit gives its apps' processes, and a process started as another user keeps no such group.
- **What it takes:** files with an SNES cartridge's header in them (`games.js`, `romInfo`: the header is looked for where a LoROM, a HiROM and an ExHiROM game have it, behind a copier's 512 bytes or not, and weighed as Snes9x weighs it; a wrong checksum does not rule a file out). 8 MB and those 512 bytes at most a game, 96 MB and 1000 games in all, under a name with folders and odd characters taken out, ending in `.sfc` or `.smc`. They go to the app's `data/roms/` folder, which the service finds itself; a request cannot name a folder.
- **It cannot restart the head unit by crashing.** No core file reaches the head unit's crash handler (`LimitCORE=1`), the Store lists the units with the head unit's recovery manager, and a service that keeps failing to start is left stopped.

## A USB gamepad

The head unit's kernel has no driver for a gamepad: no HID, no input events, no joystick driver. A pad plugged into the car's USB port is listed on the bus and nothing more, and an app may not open USB devices. So, with the app's setting **USB gamepad** on (it is, at first):

1. While its drawn screen shows, a game or the list of games, the app asks the loader for a pad (`{"cmd":"pad"}` on the same socket).
2. The loader looks for one on the USB bus every two seconds: an interface of class `ff`, subclass `47`, protocol `d0`, which is an Xbox One or Xbox Series pad on a cable, or another make's pad for that console.
3. It starts `snes-usbpipe` on it. That program knows nothing about gamepads: it passes the packets of one USB interface on as lines of text, in both directions, through the kernel's usbfs.
4. `pad.js` sends the packets that switch the pad on, reads its reports, and the loader tells the app the buttons whenever they change. The packets and the report's layout are those of the Linux kernel's own driver (`drivers/input/joystick/xpad.c`).
5. When that screen is left, the app leaves, or the pad is pulled out, `snes-usbpipe` ends. Nothing reads the USB bus while the app shows the head unit's own menus, or nothing.

- **Not root.** `snes-usbpipe` runs as the SNES app's user, in the group the head unit gives its USB device files to. It opens the one device the loader names and unbinds no driver.
- **No port, no firewall rule.** The buttons go over the socket only the SNES app can reach.
- **A pad that cannot be read is left alone** after five tries in a row, until the next game.
- **What the SNES app gets:** the pad's D-pad, with the left stick counted as one, its buttons A, B, X, Y, LB, RB, Menu and View, and three things an SNES pad does not have: the two sticks pressed in, and the Xbox button. The app makes its way out of a game of those, because all twelve of an SNES pad's buttons are the game's. `pad.js` reads the rest of the pad too, for a program that wants a pad with two sticks: both sticks and both triggers (`onState` of its `open`). None of that goes over the loader's socket. `node tools/pad-try.js --state` shows it from a pad on a PC.
- **`snes-usbpipe` is a program, not a script:** Node.js has no way to talk to usbfs. It is built from `src/snes-usbpipe/main.go`, one file with no library beside Go's own, by `npm run build:usbpipe` on any computer, and is committed here as the Store installs it. It needs nothing of the head unit but its kernel. Its source is the NES project's `nes-usbpipe`, with its name changed.

What has run, on a PC (2026-11-20): the meaning of the packets against the kernel driver's and against packets a real Xbox One S pad sent (the NES project's captures), the pad found in a copy of what a head unit lists for that pad, and the whole way from a stand-in for `snes-usbpipe` through the loader to the app. The app in the emulator asked this loader for a pad and was answered. **No real pad has been read by this loader**, on a PC or a car; the NES loader, from which every line that touches the pad comes, has read one on both. **The sticks pressed in and the Xbox button** are read where the kernel's driver has them; no real pad's report of either has been seen by this code or by the NES project's.

## A game's sound

An app has no sound device. With the app's setting **Sound on the car's speakers** on (it is, at first), while a game runs:

1. The app opens a second connection to the loader's socket and asks: `{"cmd":"sound","rate":32040}`. The rate is the emulator core's, and an SNES core's is 32040 or so. After the loader's answer that connection carries nothing but the game's sound, as the emulator makes it: signed 16-bit samples, left and right.
2. The loader starts `snes-sound` and hands it that sound. `snes-sound` brings it to the device's 48000 samples a second and plays it into `plug:smartx:CarLifeMedia_CF_48_STEREO`: the input of the head unit's own sound mixer (SmartXbar) for CarLife, a phone system no phone outside China uses.
3. The app asks the head unit's audio manager to connect that input, its source 287, to the front speakers (`app/caraudio.js`). Until it does, the mixer takes nothing and `snes-sound` says it waits.
4. When the game stops, the app closes the connection; `snes-sound` closes the device and ends, and the app has the audio manager disconnect what it connected.

- **Not root.** `snes-sound` runs as `nobody`, in the group the head unit gives its sound devices to (`mgu_alsa`), and refuses to run as root. A head unit without that group gets no sound; the app says why beside the game.
- **No port, no firewall rule,** and nothing plays while no game runs.
- **The speakers play one such source at a time:** the game's sound takes the place of the radio or a phone's music, until the game stops. What the head unit plays then is its own decision. The NES app's sound uses the same source: one of the two apps is heard at a time.
- **Late sound is dropped, not played late.** The loader and `snes-sound` keep a quarter and a half of a second at most; `snes-sound` plays about 40 ms behind what it is sent, a shade slower or faster as needed, because the game's clock and the sound device's are two. (The app runs the console at 60 frames a second and an SNES makes its sound for 60.1 or 59.9: that small difference is taken up here too.)
- **A player that cannot play is left alone** after five tries in a row, until the next game.
- **`snes-sound` is a program, not a script:** Node.js has no way to the head unit's sound library. It is built from `src/snes-sound/main.go` by `npm run build:sound` on any computer, without a C compiler, and is committed here as the Store installs it. It needs the head unit's C library and, to play, its `libasound.so.2`, which it loads when it starts. Its source is the NES project's `nes-sound`, with its name changed.

Whose way this is: the route to the speakers (source 287 to the front speakers) is Moonride's (JustAnotherPU), and aurelmarius' TVH Player and M850i-amn's IPTV use it; `snes-sound` opens and writes the device as their player, `tvh-player`, does. [clucraft/plex-idrive](https://github.com/clucraft/plex-idrive) carries that player and that request. `app/caraudio.js` is M850i-amn's file (MIT; the app's `NOTICE`); `snes-sound` is this project's own program.

What has run, on a PC (2026-11-20): the sound out of the emulator, a note as the note it is; the app's request and the sound through the loader to a stand-in for `snes-sound`; the request for the speakers against a stand-in for the audio manager; and `snes-sound` itself on Linux, playing a note into a file at the device's pace from 32040, 48000 and 44100 samples a second, and reaching the C library's loader of libraries. And the bundled game through all of it but the device: `node tools/sound-try.js` runs *Pad Test* in the app's core at the console's pace, feeds `snes-sound` as the loader would, and measures what it wrote for the device: Pad Test's beeps came out 1.000 s apart, at 994 Hz with the core's own sound chip emulation and 1002 Hz with blargg's (1000 is right). It leaves a `.wav` to listen to. **What has not run anywhere: this `snes-sound` with a head unit's sound library and mixer.** The NES project's `nes-sound`, built from the same source, was heard on one car at 48000 samples a second in; no car has played sound that came in at another rate.

## Removing it

Remove **SNES game loader** in the Store. That takes out its units, its folder `/var/opt/clucraft-snes-loader` and any firewall rule of its own. Games already sent stay with the app. The NES game loader, when it is installed too, is not touched.

## Files

```
component.json   what the MGU Store installs: the files, the two units, the check after an install
service.js       the service
page.js          the page and its requests
games.js         the app's games folder; what counts as a game; saving and removing one
nft.js           the firewall rules
sockgroup.js     the socket for the SNES app alone
pad.js           a USB gamepad: finding it, switching it on, what its packets mean
snes-usbpipe     the program that passes its packets on (built from src/snes-usbpipe/main.go)
sound.js         a game's sound: whom the program that plays it runs as, starting and ending it
snes-sound       the program that plays it (built from src/snes-sound/main.go)
check.js         the Store's check: the service answers
cleanup.js       the firewall as it was (after a stop, before a removal)
systemd/         clucraft-snes-loader.socket, clucraft-snes-loader.service
```

On a PC the same files run with the emulator, without root and without a firewall (`tools/loader-dev.js`, started by `npm run emu`): see "Try it in the emulator" in the [main README](../README.md).

MIT, as this project's own files are (`LICENSE`). `snes-sound` has one library in it beside Go's own, [purego](https://github.com/ebitengine/purego) (Apache-2.0, `LICENSE.purego`), through which it calls the head unit's sound library. The loader has nothing of the emulator in it: the emulator core's licence, which makes the app non-commercial, is not the loader's.

The way it works, a service the app starts through a socket, a page behind a QR code, and a firewall rule for as long as the page is open, is how [aurelmarius/bmw-apps](https://github.com/aurelmarius/bmw-apps) signs in its TV and AirPlay apps, on cars. That showed it can be done on this head unit. The code here is its own.
